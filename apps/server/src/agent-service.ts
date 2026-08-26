import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  createWorkspaceCheckpoint,
  pruneCheckpoints,
  restoreWorkspaceCheckpoint,
} from "./agentguard/checkpoint.js";
import { classifyFailure, severityFor } from "./agentguard/failure-detector.js";
import {
  retryBackoffMs,
  selectStrategy,
  shouldAbortAfterAttempts,
} from "./agentguard/policy.js";
import {
  abortIncident,
  completeRecoveryAttempt,
  openIncident,
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

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly pendingInjections = new Map<string, InjectFailType>();
  private readonly injectionCancels = new Set<string>();

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
          run.status === "recovering"
        ) {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
        if (typeof run.recoveryAttemptCount !== "number") {
          run.recoveryAttemptCount = 0;
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
    if (run.status !== "running" && run.status !== "recovering") {
      throw new HttpError(409, "Failure injection requires an active run");
    }
    this.pendingInjections.set(runId, type);
    this.injectionCancels.add(run.agentId);
    await this.runner.cancel(run.agentId);
    return { ok: true };
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

        const injected = this.pendingInjections.get(run.id);
        if (injected) {
          this.pendingInjections.delete(run.id);
          this.injectionCancels.delete(agent.id);
          const recovered = await this.handleFailure({
            agent,
            run,
            injected,
            timedOut: injected === "tool_timeout",
            cancelled: false,
            message: "Injected " + injected,
          });
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
          storedRun.usage = result.usage;
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

        // Ensure a checkpoint exists before crash recovery when spans already ran.
        if (
          (injected === "runtime_crash" || /exited with code|crash/i.test(message)) &&
          !this.latestCheckpoint(run.id)
        ) {
          await this.checkpointAfterSpan(agent.id, run.id, "pre_recovery");
          agent = this.getAgent(agent.id);
        }

        const recovered = await this.handleFailure({
          agent,
          run,
          injected: injected ?? null,
          timedOut,
          cancelled: false,
          message,
        });
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

    if (strategy === "restart_resume") {
      const checkpoint = this.latestCheckpoint(input.run.id);
      if (!checkpoint) {
        await abortIncident(
          this.store,
          incident.id,
          "No checkpoint available for restart_resume",
        );
        await this.failRun(input.agent.id, input.run.id, input.message, false);
        return { action: "done" };
      }
      const attempt = await startRecoveryAttempt(this.store, { incident, strategy });
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
          if (run) run.status = "running";
        });
        await completeRecoveryAttempt(this.store, attempt.id, "succeeded");
        return {
          action: "restart_resume",
          attemptId: attempt.id,
          backoffMs: retryBackoffMs(priorAttempts + 1),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await completeRecoveryAttempt(this.store, attempt.id, "failed", message);
        await abortIncident(this.store, incident.id, message);
        await this.failRun(input.agent.id, input.run.id, message, false);
        return { action: "done" };
      }
    }

    // retry
    const attempt = await startRecoveryAttempt(this.store, { incident, strategy });
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === input.run.id);
      const agent = database.agents.find((item) => item.id === input.agent.id);
      if (run) run.status = "running";
      if (agent) {
        agent.status = "busy";
        agent.updatedAt = now();
      }
    });
    await completeRecoveryAttempt(this.store, attempt.id, "succeeded");
    return {
      action: "retry",
      attemptId: attempt.id,
      backoffMs: retryBackoffMs(priorAttempts + 1),
    };
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
