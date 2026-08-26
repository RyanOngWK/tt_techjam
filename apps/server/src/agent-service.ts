import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  createWorkspaceCheckpoint,
  pruneCheckpoints,
  restoreWorkspaceCheckpoint,
} from "./agentguard/checkpoint.js";
import { classifyFailure, severityFor, totalTokens } from "./agentguard/failure-detector.js";
import {
  requiresApprovalForCrash,
  retryBackoffMs,
  selectStrategy,
  shouldAbortAfterAttempts,
} from "./agentguard/policy.js";
import {
  abortIncident,
  completeRecoveryAttempt,
  openIncident,
  requestApproval,
  startRecoveryAttempt,
  verifyRecovery,
} from "./agentguard/recovery-controller.js";
import { appendTraceEvent, eventsForRun } from "./agentguard/trace-collector.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  ApprovalDecision,
  Checkpoint,
  CreateAgentInput,
  Incident,
  InjectFailType,
  Message,
  RecoveryAttempt,
  TraceEvent,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ApprovalWaiter = {
  resolve: (decision: ApprovalDecision) => void;
  incidentId: string;
};

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly pendingInjections = new Map<string, InjectFailType>();
  private readonly injectionCancels = new Set<string>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "recovering" ||
          run.status === "awaiting_approval"
        ) {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          run.pendingApprovalIncidentId = null;
        }
        if (typeof run.recoveryAttemptCount !== "number") {
          run.recoveryAttemptCount = 0;
        }
        if (typeof run.tokensUsed !== "number") run.tokensUsed = 0;
        if (typeof run.tokenBudget !== "number") {
          run.tokenBudget = this.config.agentGuardTokenBudget;
        }
        if (run.pendingApprovalIncidentId === undefined) {
          run.pendingApprovalIncidentId = null;
        }
      }
      for (const attempt of database.recoveryAttempts) {
        if (attempt.status === "started") {
          attempt.status = "failed";
          attempt.completedAt = now();
          attempt.error = "Server restarted during recovery";
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      const runIds = new Set(
        database.runs.filter((run) => run.agentId === id).map((run) => run.id),
      );
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.events = database.events.filter((item) => !runIds.has(item.runId));
      database.incidents = database.incidents.filter((item) => !runIds.has(item.runId));
      database.recoveryAttempts = database.recoveryAttempts.filter(
        (item) => !runIds.has(item.runId),
      );
      database.checkpoints = database.checkpoints.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getEvents(runId: string): TraceEvent[] {
    this.getRun(runId);
    return eventsForRun(this.store, runId);
  }

  getIncidents(runId?: string): Incident[] {
    const incidents = this.store.snapshot().incidents;
    return (runId ? incidents.filter((item) => item.runId === runId) : incidents).sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
  }

  getRecoveries(runId: string): RecoveryAttempt[] {
    this.getRun(runId);
    return this.store
      .snapshot()
      .recoveryAttempts.filter((item) => item.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getCheckpoints(runId: string): Checkpoint[] {
    this.getRun(runId);
    return this.store
      .snapshot()
      .checkpoints.filter((item) => item.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async injectFailure(runId: string, type: InjectFailType): Promise<{ ok: true }> {
    const run = this.getRun(runId);
    if (type === "budget_exceeded") {
      if (!["running", "recovering", "awaiting_approval"].includes(run.status)) {
        throw new HttpError(409, "Budget injection requires an active run");
      }
      this.pendingInjections.set(runId, type);
      if (run.status === "running" || run.status === "recovering") {
        this.injectionCancels.add(run.agentId);
        await this.runner.cancel(run.agentId);
      }
      return { ok: true };
    }
    if (run.status !== "running" && run.status !== "recovering") {
      throw new HttpError(409, "Failure injection requires an active run");
    }
    this.pendingInjections.set(runId, type);
    this.injectionCancels.add(run.agentId);
    await this.runner.cancel(run.agentId);
    return { ok: true };
  }

  async resolveApproval(
    runId: string,
    decision: ApprovalDecision,
  ): Promise<{ ok: true; decision: ApprovalDecision }> {
    const run = this.getRun(runId);
    if (run.status !== "awaiting_approval") {
      throw new HttpError(409, "Run is not awaiting approval");
    }
    const waiter = this.approvalWaiters.get(runId);
    if (!waiter) {
      throw new HttpError(409, "No pending approval waiter for this run");
    }
    await appendTraceEvent(this.store, {
      runId,
      type: decision === "approve" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
      status: decision === "approve" ? "ok" : "error",
      metadata: { incidentId: waiter.incidentId, decision },
    });
    waiter.resolve(decision);
    this.approvalWaiters.delete(runId);
    return { ok: true, decision };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      recoveryAttemptCount: 0,
      tokensUsed: 0,
      tokenBudget: this.config.agentGuardTokenBudget,
      pendingApprovalIncidentId: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      middleware: "AgentGuard",
      agentGuardTokenBudget: this.config.agentGuardTokenBudget,
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    await appendTraceEvent(this.store, {
      runId: run.id,
      type: "RUN_STARTED",
      status: "running",
      metadata: { agentId: agentAtStart.id },
    });

    let pendingVerifyAttemptId: string | null = null;
    let agent = this.getAgent(agentAtStart.id);
    let prompt = run.prompt;
    let attempts = 0;

    while (attempts < 8) {
      attempts += 1;
      try {
        if (this.cancellationRequests.has(agent.id) && !this.pendingInjections.has(run.id)) {
          throw new RunCancelledError();
        }

        const result = await this.runner.run({
          agentId: agent.id,
          workspacePath: agent.workspacePath,
          prompt,
          threadId: agent.codexThreadId,
          onEvent: async (event) => {
            await appendTraceEvent(this.store, {
              runId: run.id,
              type: event.type,
              status: event.status,
              metadata: event.metadata ?? {},
              error: event.error ?? null,
            });
            if (
              (event.type === "MODEL_CALL" || event.type === "TOOL_CALL") &&
              event.status === "ok"
            ) {
              await this.checkpointAfterSpan(agent.id, run.id, event.type.toLowerCase());
              agent = this.getAgent(agent.id);
            }
          },
        });

        // Ensure at least one checkpoint and span for demos with sparse JSONL.
        const existingSpans = eventsForRun(this.store, run.id).filter(
          (event) => event.type === "MODEL_CALL" || event.type === "TOOL_CALL",
        );
        if (existingSpans.length === 0) {
          await appendTraceEvent(this.store, {
            runId: run.id,
            type: "MODEL_CALL",
            status: "ok",
            metadata: { synthesized: true },
          });
          await this.checkpointAfterSpan(agent.id, run.id, "after_turn");
          agent = this.getAgent(agent.id);
        }
        if (pendingVerifyAttemptId) {
          await verifyRecovery(this.store, pendingVerifyAttemptId);
          pendingVerifyAttemptId = null;
        }

        // Accumulate usage and enforce token budget.
        const added = totalTokens(result.usage);
        const runAfterUsage = await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (!storedRun) return null;
          storedRun.tokensUsed += added;
          if (result.usage) {
            storedRun.usage = {
              inputTokens:
                (storedRun.usage?.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
              cachedInputTokens:
                (storedRun.usage?.cachedInputTokens ?? 0) +
                (result.usage.cachedInputTokens ?? 0),
              outputTokens:
                (storedRun.usage?.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
            };
          }
          return structuredClone(storedRun);
        });
        if (
          runAfterUsage &&
          runAfterUsage.tokenBudget > 0 &&
          runAfterUsage.tokensUsed > runAfterUsage.tokenBudget
        ) {
          await appendTraceEvent(this.store, {
            runId: run.id,
            type: "BUDGET_EXCEEDED",
            status: "error",
            metadata: {
              tokensUsed: runAfterUsage.tokensUsed,
              tokenBudget: runAfterUsage.tokenBudget,
            },
          });
          const recovered = await this.handleFailure({
            agent,
            run: runAfterUsage,
            injected: "budget_exceeded",
            timedOut: false,
            cancelled: false,
            message:
              "Token budget exceeded: " +
              runAfterUsage.tokensUsed +
              "/" +
              runAfterUsage.tokenBudget,
          });
          if (recovered.action === "awaiting_approval") {
            const decision = await this.waitForApproval(run.id, recovered.incidentId);
            if (decision === "abort") {
              await abortIncident(
                this.store,
                recovered.incidentId,
                "Operator denied recovery after budget exceed",
              );
              await this.failRun(agent.id, run.id, "Budget exceeded; recovery denied", false);
              return;
            }
            await this.raiseTokenBudget(run.id, recovered.incidentId);
            // Budget trip after a successful turn: allow completion with raised budget.
          } else if (recovered.action === "done") {
            return;
          }
        }

        const injected = this.pendingInjections.get(run.id);
        if (injected) {
          this.pendingInjections.delete(run.id);
          this.injectionCancels.delete(agent.id);
          const recovered = await this.handleFailure({
            agent,
            run: this.getRun(run.id),
            injected,
            timedOut: injected === "tool_timeout",
            cancelled: false,
            message: "Injected " + injected,
          });
          if (recovered.action === "awaiting_approval") {
            const decision = await this.waitForApproval(run.id, recovered.incidentId);
            if (decision === "abort") {
              await abortIncident(
                this.store,
                recovered.incidentId,
                "Operator denied recovery",
              );
              await this.failRun(agent.id, run.id, "Recovery denied by operator", false);
              return;
            }
            if (recovered.failureType === "budget_exceeded") {
              await this.raiseTokenBudget(run.id, recovered.incidentId);
              pendingVerifyAttemptId = null;
              agent = this.getAgent(agent.id);
              prompt = run.prompt;
              continue;
            }
            const afterApprove = await this.performApprovedRecovery({
              agent,
              run: this.getRun(run.id),
              incidentId: recovered.incidentId,
              failureType: recovered.failureType,
            });
            if (afterApprove.action === "retry" || afterApprove.action === "restart_resume") {
              pendingVerifyAttemptId = afterApprove.attemptId;
              agent = this.getAgent(agent.id);
              prompt =
                afterApprove.action === "retry"
                  ? run.prompt
                  : "Resume the previous task after a runtime interruption. Continue from the latest workspace state.";
              continue;
            }
            return;
          }
          if (recovered.action === "retry" || recovered.action === "restart_resume") {
            pendingVerifyAttemptId = recovered.attemptId;
            agent = this.getAgent(agent.id);
            prompt =
              recovered.action === "retry"
                ? run.prompt
                : "Resume the previous task after a runtime interruption. Continue from the latest workspace state.";
            if (recovered.backoffMs) await sleep(recovered.backoffMs);
            continue;
          }
          return;
        }

        const completedAt = now();
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const storedAgent = database.agents.find((item) => item.id === agent.id);
          if (!storedRun || !storedAgent) return;
          storedRun.status = "completed";
          storedRun.output = result.output;
          storedRun.completedAt = completedAt;
          database.messages.push({
            id: randomUUID(),
            agentId: storedAgent.id,
            runId: run.id,
            role: "assistant",
            content: result.output,
            createdAt: completedAt,
          });
          storedAgent.status = "ready";
          storedAgent.codexThreadId = result.threadId;
          storedAgent.lastError = null;
          storedAgent.updatedAt = completedAt;
        });
        await appendTraceEvent(this.store, {
          runId: run.id,
          type: "RUN_COMPLETED",
          status: "ok",
          metadata: { usage: result.usage },
        });
        return;
      } catch (error) {
        const cancelled = error instanceof RunCancelledError;
        const message = error instanceof Error ? error.message : String(error);
        const injected = this.pendingInjections.get(run.id);
        const injectionCancel = this.injectionCancels.has(agent.id);

        if (cancelled && !injected && !injectionCancel) {
          await this.failRun(agent.id, run.id, message, true);
          await appendTraceEvent(this.store, {
            runId: run.id,
            type: "RUN_FAILED",
            status: "error",
            error: message,
            metadata: { cancelled: true },
          });
          return;
        }

        const timedOut =
          Boolean(injected === "tool_timeout") ||
          /timed out|timeout/i.test(message);
        this.pendingInjections.delete(run.id);
        this.injectionCancels.delete(agent.id);

        if (
          (injected === "runtime_crash" || /exited with code|crash/i.test(message)) &&
          !this.latestCheckpoint(run.id)
        ) {
          await this.checkpointAfterSpan(agent.id, run.id, "pre_recovery");
          agent = this.getAgent(agent.id);
        }

        const recovered = await this.handleFailure({
          agent,
          run: this.getRun(run.id),
          injected: injected ?? null,
          timedOut,
          cancelled: false,
          message,
        });
        if (recovered.action === "awaiting_approval") {
          const decision = await this.waitForApproval(run.id, recovered.incidentId);
          if (decision === "abort") {
            await abortIncident(
              this.store,
              recovered.incidentId,
              "Operator denied recovery",
            );
            await this.failRun(agent.id, run.id, "Recovery denied by operator", false);
            return;
          }
          if (recovered.failureType === "budget_exceeded") {
            await this.raiseTokenBudget(run.id, recovered.incidentId);
            pendingVerifyAttemptId = null;
            agent = this.getAgent(agent.id);
            prompt = run.prompt;
            continue;
          }
          const afterApprove = await this.performApprovedRecovery({
            agent,
            run: this.getRun(run.id),
            incidentId: recovered.incidentId,
            failureType: recovered.failureType,
          });
          if (afterApprove.action === "retry" || afterApprove.action === "restart_resume") {
            pendingVerifyAttemptId = afterApprove.attemptId;
            agent = this.getAgent(agent.id);
            prompt =
              afterApprove.action === "retry"
                ? run.prompt
                : "Resume the previous task after a runtime interruption. Continue from the latest workspace state.";
            continue;
          }
          return;
        }
        if (recovered.action === "retry" || recovered.action === "restart_resume") {
          pendingVerifyAttemptId = recovered.attemptId;
          agent = this.getAgent(agent.id);
          prompt =
            recovered.action === "retry"
              ? run.prompt
              : "Resume the previous task after a runtime interruption. Continue from the latest workspace state.";
          if (recovered.backoffMs) await sleep(recovered.backoffMs);
          continue;
        }
        return;
      }
    }

    await this.failRun(agent.id, run.id, "Recovery attempt limit exceeded", false);
  }

  private async checkpointAfterSpan(
    agentId: string,
    runId: string,
    boundary: string,
  ): Promise<void> {
    const agent = this.getAgent(agentId);
    const checkpoint = await createWorkspaceCheckpoint({
      dataDirectory: this.config.dataDirectory,
      runId,
      agentId,
      workspacePath: agent.workspacePath,
      codexThreadId: agent.codexThreadId,
      boundary,
    });
    await this.store.mutate(async (database) => {
      database.checkpoints.push(checkpoint);
      database.checkpoints = await pruneCheckpoints(database.checkpoints, runId);
    });
    await appendTraceEvent(this.store, {
      runId,
      type: "CHECKPOINT_CREATED",
      status: "ok",
      metadata: {
        checkpointId: checkpoint.id,
        boundary,
        codexThreadId: checkpoint.codexThreadId,
      },
    });
  }

  private async handleFailure(input: {
    agent: Agent;
    run: AgentRun;
    injected: InjectFailType | null;
    timedOut: boolean;
    cancelled: boolean;
    message: string;
  }): Promise<
    | { action: "done" }
    | { action: "retry" | "restart_resume"; attemptId: string; backoffMs: number }
    | {
        action: "awaiting_approval";
        incidentId: string;
        failureType: import("./types.js").FailureType;
      }
  > {
    const errorEvent = await appendTraceEvent(this.store, {
      runId: input.run.id,
      type: "ERROR",
      status: "error",
      error: input.message,
      metadata: { injected: input.injected },
    });
    const failureType = classifyFailure({
      injected: input.injected,
      timedOut: input.timedOut,
      cancelled: input.cancelled,
      budgetExceeded: input.injected === "budget_exceeded",
      message: input.message,
    });
    const incident = await openIncident(this.store, {
      runId: input.run.id,
      eventId: errorEvent.id,
      failureType,
      severity: severityFor(failureType),
    });

    const strategy = selectStrategy(failureType);
    const priorAttempts = this.store
      .snapshot()
      .recoveryAttempts.filter(
        (item) => item.runId === input.run.id && item.strategy === strategy,
      ).length;
    const priorCrashRecoveries = this.store
      .snapshot()
      .recoveryAttempts.filter(
        (item) =>
          item.runId === input.run.id && item.strategy === "restart_resume",
      ).length;

    if (failureType === "budget_exceeded") {
      await requestApproval(
        this.store,
        incident,
        "Token budget exceeded; approve to raise budget or abort",
      );
      return {
        action: "awaiting_approval",
        incidentId: incident.id,
        failureType,
      };
    }

    if (
      failureType === "runtime_crash" &&
      requiresApprovalForCrash(
        priorCrashRecoveries,
        this.config.agentGuardRequireApprovalAfterCrashes,
      )
    ) {
      await requestApproval(
        this.store,
        incident,
        "Additional crash recovery requires operator approval",
      );
      return {
        action: "awaiting_approval",
        incidentId: incident.id,
        failureType,
      };
    }

    if (strategy === "abort" || shouldAbortAfterAttempts(failureType, priorAttempts)) {
      await abortIncident(
        this.store,
        incident.id,
        "Recovery policy aborted: " + failureType,
      );
      await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === input.agent.id);
        if (agent && agent.status !== "stopped") {
          agent.status = "error";
          agent.lastError = input.message;
          agent.updatedAt = now();
        }
      });
      await appendTraceEvent(this.store, {
        runId: input.run.id,
        type: "RUN_FAILED",
        status: "error",
        error: input.message,
      });
      return { action: "done" };
    }

    if (strategy === "restart_resume" || strategy === "retry") {
      return this.startCheckpointedRecovery({
        agent: input.agent,
        run: input.run,
        incident,
        strategy,
        priorAttempts,
        errorEventId: errorEvent.id,
      });
    }

    await abortIncident(this.store, incident.id, "No recovery strategy");
    return { action: "done" };
  }

  private async startCheckpointedRecovery(input: {
    agent: Agent;
    run: AgentRun;
    incident: Incident;
    strategy: "retry" | "restart_resume";
    priorAttempts: number;
    errorEventId: string;
  }): Promise<
    | { action: "done" }
    | { action: "retry" | "restart_resume"; attemptId: string; backoffMs: number }
  > {
    const checkpoint = this.latestCheckpoint(input.run.id);
    if (!checkpoint) {
      await abortIncident(
        this.store,
        input.incident.id,
        "No checkpoint available for " + input.strategy,
      );
      await this.failRun(input.agent.id, input.run.id, "No checkpoint available", false);
      return { action: "done" };
    }
    const attempt = await startRecoveryAttempt(this.store, {
      incident: input.incident,
      strategy: input.strategy,
      metadata: {
        retryOf: input.errorEventId,
        checkpointId: checkpoint.id,
      },
    });
    try {
      await restoreWorkspaceCheckpoint({
        workspacePath: input.agent.workspacePath,
        checkpoint,
      });
      await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === input.agent.id);
        const run = database.runs.find((item) => item.id === input.run.id);
        if (agent) {
          agent.codexThreadId = checkpoint.codexThreadId;
          agent.status = "busy";
          agent.updatedAt = now();
        }
        if (run) {
          run.status = "running";
          run.pendingApprovalIncidentId = null;
        }
      });
      await completeRecoveryAttempt(this.store, attempt.id, "succeeded");
      return {
        action: input.strategy,
        attemptId: attempt.id,
        backoffMs: retryBackoffMs(input.priorAttempts + 1),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeRecoveryAttempt(this.store, attempt.id, "failed", message);
      await abortIncident(this.store, input.incident.id, message);
      await this.failRun(input.agent.id, input.run.id, message, false);
      return { action: "done" };
    }
  }

  private async performApprovedRecovery(input: {
    agent: Agent;
    run: AgentRun;
    incidentId: string;
    failureType: import("./types.js").FailureType;
  }): Promise<
    | { action: "done" }
    | { action: "retry" | "restart_resume"; attemptId: string; backoffMs: number }
  > {
    const incident = this.store
      .snapshot()
      .incidents.find((item) => item.id === input.incidentId);
    if (!incident) return { action: "done" };
    const strategy =
      input.failureType === "budget_exceeded"
        ? "abort"
        : selectStrategy(input.failureType);
    if (strategy === "abort") {
      await abortIncident(this.store, incident.id, "Approved path still aborts");
      return { action: "done" };
    }
    const priorAttempts = this.store
      .snapshot()
      .recoveryAttempts.filter(
        (item) => item.runId === input.run.id && item.strategy === strategy,
      ).length;
    return this.startCheckpointedRecovery({
      agent: input.agent,
      run: input.run,
      incident,
      strategy,
      priorAttempts,
      errorEventId: incident.eventId,
    });
  }

  private async raiseTokenBudget(runId: string, incidentId: string): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const incident = database.incidents.find((item) => item.id === incidentId);
      if (storedRun) {
        storedRun.tokenBudget =
          storedRun.tokensUsed + this.config.agentGuardTokenBudget;
        storedRun.pendingApprovalIncidentId = null;
        storedRun.status = "running";
      }
      if (incident) {
        incident.status = "resolved";
        incident.resolvedAt = now();
      }
    });
    await appendTraceEvent(this.store, {
      runId,
      type: "BUDGET_RAISED",
      status: "ok",
      metadata: { incidentId, raisedBudget: true },
    });
  }

  private waitForApproval(
    runId: string,
    incidentId: string,
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.approvalWaiters.set(runId, { resolve, incidentId });
    });
  }

  private latestCheckpoint(runId: string): Checkpoint | null {
    const checkpoints = this.store
      .snapshot()
      .checkpoints.filter((item) => item.runId === runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return checkpoints[0] ?? null;
  }

  private async failRun(
    agentId: string,
    runId: string,
    message: string,
    cancelled: boolean,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (storedRun) {
        storedRun.status = cancelled ? "cancelled" : "failed";
        storedRun.error = message;
        storedRun.completedAt = completedAt;
        storedRun.pendingApprovalIncidentId = null;
      }
      if (agent) {
        if (agent.status !== "stopped") {
          agent.status = cancelled ? "ready" : "error";
        }
        agent.lastError = cancelled ? null : message;
        agent.updatedAt = completedAt;
      }
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
