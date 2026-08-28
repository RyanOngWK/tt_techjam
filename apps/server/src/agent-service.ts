import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  budgetTier,
  projectUsage,
  shouldBlockPreTurn,
  shouldCancelMidTurn,
  summarizeTraceEvent,
  wrapPrompt,
  type BudgetEstimates,
  type BudgetTier,
} from "./agentguard/budget-policy.js";
import {
  createWorkspaceCheckpoint,
  listSnapshotEntries,
  pruneCheckpoints,
  restoreWorkspaceCheckpoint,
} from "./agentguard/checkpoint.js";
import { classifyFailure, severityFor, totalTokens } from "./agentguard/failure-detector.js";
import { diagnosesForRun, issueDiagnosis, updateDiagnosis } from "./agentguard/diagnostic.js";
import {
  requiresApprovalForCrash,
  retryBackoffMs,
  selectStrategy,
  shouldAbortAfterAttempts,
  strategyRationaleFor,
} from "./agentguard/policy.js";
import { registerSecretValues } from "./agentguard/redact.js";
import {
  abortIncident,
  completeRecoveryAttempt,
  openIncident,
  requestApproval,
  startRecoveryAttempt,
  verifyRecovery,
} from "./agentguard/recovery-controller.js";
import {
  applyPatch,
  buildSettingsResponse,
  mergeSettings,
  validateEffectiveRatios,
  type PatchAgentGuardSettingsInput,
} from "./agentguard/settings.js";
import {
  appendTraceEvent,
  endSpan,
  eventsForRun,
  startSpan,
} from "./agentguard/trace-collector.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  ApprovalDecision,
  Checkpoint,
  CreateAgentInput,
  DiagnosisRecord,
  DiagnosisStateDelta,
  Incident,
  InjectFailType,
  Message,
  RecoveryAttempt,
  TraceEvent,
  UpdateAgentInput,
  AgentGuardSettingsResponse,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateEventBytes(metadata: Record<string, unknown> | undefined): number {
  if (!metadata) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(metadata), "utf8");
  } catch {
    return 0;
  }
}

type ApprovalWaiter = {
  resolve: (decision: ApprovalDecision) => void;
  incidentId: string;
};

interface TraceContext {
  runId: string;
  runSpanId: string;
  turnSpanId: string | null;
  failingSpanId: string | null;
  attemptIndex: number;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly pendingInjections = new Map<string, InjectFailType>();
  private readonly injectionCancels = new Set<string>();
  private readonly budgetProjectedCancels = new Set<string>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    const { skippedTooShort } = registerSecretValues([
      { label: "arkApiKey", value: this.config.arkApiKey },
      { label: "authToken", value: this.config.authToken },
    ]);
    if (skippedTooShort.length > 0) {
      console.warn(
        "Secret values too short to register for redaction: " +
          skippedTooShort.join(", "),
      );
    }
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
          run.tokenBudget = this.effectiveSettings().tokenBudget;
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
      database.diagnoses = database.diagnoses.filter((item) => !runIds.has(item.runId));
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

  getDiagnoses(runId: string): DiagnosisRecord[] {
    this.getRun(runId);
    return diagnosesForRun(this.store, runId);
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
    if (type === "runtime_crash" && typeof this.runner.kill === "function") {
      await this.runner.kill(run.agentId);
    } else {
      this.injectionCancels.add(run.agentId);
      await this.runner.cancel(run.agentId);
    }
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
    const incidentTrace = this.traceOptionsForIncident(waiter.incidentId);
    await appendTraceEvent(this.store, {
      runId,
      type: decision === "approve" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
      status: decision === "approve" ? "ok" : "error",
      parentEventId: incidentTrace.parentEventId,
      attemptIndex: incidentTrace.attemptIndex,
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
      tokenBudget: this.effectiveSettings().tokenBudget,
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
      agentGuardTokenBudget: this.effectiveSettings().tokenBudget,
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
    const runSpan = await appendTraceEvent(this.store, {
      runId: run.id,
      type: "RUN_STARTED",
      status: "ok",
      metadata: { agentId: agentAtStart.id },
    });
    const trace: TraceContext = {
      runId: run.id,
      runSpanId: runSpan.id,
      turnSpanId: null,
      failingSpanId: null,
      attemptIndex: 0,
    };

    let pendingVerifyAttemptId: string | null = null;
    let agent = this.getAgent(agentAtStart.id);
    let turnPrompt = run.prompt;
    let attempts = 0;
    let lastEmittedTier: BudgetTier | "none" = "none";
    let preTurnBlockedOnce = false;

    while (attempts < 8) {
      attempts += 1;
      try {
        trace.attemptIndex = attempts - 1;
        if (this.cancellationRequests.has(agent.id) && !this.pendingInjections.has(run.id)) {
          throw new RunCancelledError();
        }

        const currentRun = this.getRun(run.id);
        const estimates = this.budgetEstimates();
        const prepared = await this.prepareTurnPrompt({
          run: currentRun,
          originalPrompt: run.prompt,
          turnPrompt,
          estimates,
          lastEmittedTier,
          preTurnBlockedOnce,
          trace,
        });
        if (prepared.action === "awaiting_approval") {
          const decision = await this.waitForApproval(run.id, prepared.incidentId);
          if (decision === "abort") {
            await abortIncident(
              this.store,
              prepared.incidentId,
              "Operator denied recovery after pre-turn budget block",
              this.traceOptionsForIncident(prepared.incidentId),
            );
            await this.failRun(agent.id, run.id, "Budget exceeded; recovery denied", false);
            return;
          }
          await this.raiseTokenBudget(run.id, prepared.incidentId);
          preTurnBlockedOnce = false;
          lastEmittedTier = "none";
          continue;
        }
        turnPrompt = prepared.turnPrompt;
        lastEmittedTier = prepared.lastEmittedTier;
        preTurnBlockedOnce = prepared.preTurnBlockedOnce;
        const promptForRunner = prepared.promptForRunner;

        let modelCalls = 0;
        let toolCalls = 0;
        let streamBytes = 0;
        let lastObservedAt: number | null = null;
        let midTurnCancelIssued = false;

        trace.turnSpanId = await startSpan(this.store, {
          runId: trace.runId,
          type: "TURN",
          parentEventId: trace.runSpanId,
          attemptIndex: trace.attemptIndex,
          metadata: {
            attemptIndex: trace.attemptIndex,
            tier: prepared.lastEmittedTier,
            promptWrapped: promptForRunner !== turnPrompt,
            codexThreadId: agent.codexThreadId,
          },
        });
        const result = await this.runner.run({
          agentId: agent.id,
          workspacePath: agent.workspacePath,
          prompt: promptForRunner,
          threadId: agent.codexThreadId,
          onEvent: async (event) => {
            const observedAt = event.observedAt ?? Date.now();
            const deltaMs = lastObservedAt === null ? null : observedAt - lastObservedAt;
            lastObservedAt = observedAt;
            await appendTraceEvent(this.store, {
              runId: run.id,
              type: event.type,
              status: event.status,
              parentEventId: trace.turnSpanId,
              attemptIndex: trace.attemptIndex,
              durationMs: deltaMs,
              durationSource: deltaMs === null ? null : "inter_item_delta",
              metadata: event.metadata ?? {},
              error: event.error ?? null,
            });
            if (
              (event.type === "MODEL_CALL" || event.type === "TOOL_CALL") &&
              event.status === "ok"
            ) {
              if (event.type === "MODEL_CALL") modelCalls += 1;
              if (event.type === "TOOL_CALL" && event.metadata?.unrecognized !== true) {
                toolCalls += 1;
              }
              streamBytes += estimateEventBytes(event.metadata);
              await this.checkpointAfterSpan(
                agent.id,
                run.id,
                event.type.toLowerCase(),
                trace.turnSpanId,
                trace.attemptIndex,
              );
              agent = this.getAgent(agent.id);

              if (!midTurnCancelIssued) {
                const liveRun = this.getRun(run.id);
                const projected = projectUsage({
                  tokensUsed: liveRun.tokensUsed,
                  modelCalls,
                  toolCalls,
                  streamBytes,
                  estimates,
                });
                const tier = budgetTier(
                  Math.max(liveRun.tokensUsed, projected),
                  liveRun.tokenBudget,
                  estimates,
                );
                if (
                  shouldCancelMidTurn({
                    projected,
                    tokenBudget: liveRun.tokenBudget,
                    tier,
                  })
                ) {
                  midTurnCancelIssued = true;
                  this.budgetProjectedCancels.add(agent.id);
                  await appendTraceEvent(this.store, {
                    runId: run.id,
                    type: "BUDGET_PROJECTED_EXCEED",
                    status: "error",
                    parentEventId: trace.turnSpanId,
                    attemptIndex: trace.attemptIndex,
                    metadata: {
                      projected,
                      tokensUsed: liveRun.tokensUsed,
                      tokenBudget: liveRun.tokenBudget,
                      modelCalls,
                      toolCalls,
                      streamBytes,
                    },
                  });
                  await this.runner.cancel(agent.id);
                }
              }
            }
          },
        });

        const completedTurnSpanId = trace.turnSpanId;
        if (completedTurnSpanId) {
          await endSpan(this.store, completedTurnSpanId, {
            status: midTurnCancelIssued ? "error" : "ok",
            error: midTurnCancelIssued
              ? "Mid-turn budget cancellation was requested, but the runner completed regardless"
              : null,
            metadata: { usage: result.usage },
          });
          if (midTurnCancelIssued) {
            trace.failingSpanId = completedTurnSpanId;
          } else {
            trace.failingSpanId = null;
          }
          trace.turnSpanId = null;
        }
        // Every completed turn gives recovery a post-turn resume point. This must
        // run after turnSpanId is cleared so a checkpoint failure cannot re-close
        // a successfully completed turn as an error in the surrounding catch.
        await this.checkpointAfterSpan(
          agent.id,
          run.id,
          "after_turn",
          trace.runSpanId,
          trace.attemptIndex,
        );
        agent = this.getAgent(agent.id);
        if (pendingVerifyAttemptId) {
          await verifyRecovery(this.store, pendingVerifyAttemptId, {
            parentEventId: completedTurnSpanId,
            attemptIndex: trace.attemptIndex,
          });
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
            parentEventId: trace.runSpanId,
            attemptIndex: trace.attemptIndex,
            metadata: {
              tokensUsed: runAfterUsage.tokensUsed,
              tokenBudget: runAfterUsage.tokenBudget,
            },
          });
          trace.failingSpanId = completedTurnSpanId;
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
            trace,
          });
          if (recovered.action === "awaiting_approval") {
            const decision = await this.waitForApproval(run.id, recovered.incidentId);
            if (decision === "abort") {
              await abortIncident(
                this.store,
                recovered.incidentId,
                "Operator denied recovery after budget exceed",
                this.traceOptionsForIncident(recovered.incidentId),
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
          trace.failingSpanId = completedTurnSpanId;
          const recovered = await this.handleFailure({
            agent,
            run: this.getRun(run.id),
            injected,
            timedOut: injected === "tool_timeout",
            cancelled: false,
            message: "Injected " + injected,
            trace,
          });
          const continued = await this.applyRecoveryContinuation({
            recovered,
            agent,
            run,
            pendingVerifyAttemptId,
            originalPrompt: run.prompt,
            trace,
          });
          if (continued.outcome === "return") return;
          pendingVerifyAttemptId = continued.pendingVerifyAttemptId;
          agent = continued.agent;
          turnPrompt = continued.turnPrompt;
          if (continued.outcome === "continue") {
            if (continued.backoffMs) await sleep(continued.backoffMs);
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
          parentEventId: trace.runSpanId,
          attemptIndex: trace.attemptIndex,
          metadata: { usage: result.usage },
        });
        return;
      } catch (error) {
        const cancelled = error instanceof RunCancelledError;
        const message = error instanceof Error ? error.message : String(error);
        if (trace.turnSpanId) {
          await endSpan(this.store, trace.turnSpanId, { status: "error", error: message });
          trace.failingSpanId = trace.turnSpanId;
          trace.turnSpanId = null;
        }
        const injected = this.pendingInjections.get(run.id);
        const injectionCancel = this.injectionCancels.has(agent.id);
        const budgetProjectedCancel = this.budgetProjectedCancels.has(agent.id);

        if (cancelled && !injected && !injectionCancel && !budgetProjectedCancel) {
          await this.failRun(agent.id, run.id, message, true);
          await appendTraceEvent(this.store, {
            runId: run.id,
            type: "RUN_FAILED",
            status: "error",
            parentEventId: trace.runSpanId,
            attemptIndex: trace.attemptIndex,
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
        this.budgetProjectedCancels.delete(agent.id);

        if (
          (injected === "runtime_crash" || /exited with code|crash/i.test(message)) &&
          !this.latestCheckpoint(run.id)
        ) {
          await this.checkpointAfterSpan(
            agent.id,
            run.id,
            "pre_recovery",
            trace.runSpanId,
            trace.attemptIndex,
          );
          agent = this.getAgent(agent.id);
        }

        const recovered = await this.handleFailure({
          agent,
          run: this.getRun(run.id),
          injected: injected ?? null,
          timedOut,
          cancelled: false,
          budgetProjectedExceeded: budgetProjectedCancel,
          message: budgetProjectedCancel
            ? "Token budget projected exceed; compressing context"
            : message,
          trace,
        });
        const continued = await this.applyRecoveryContinuation({
          recovered,
          agent,
          run,
          pendingVerifyAttemptId,
          originalPrompt: run.prompt,
          trace,
        });
        if (continued.outcome === "return") return;
        pendingVerifyAttemptId = continued.pendingVerifyAttemptId;
        agent = continued.agent;
        turnPrompt = continued.turnPrompt;
        if (continued.outcome === "continue") {
          if (continued.backoffMs) await sleep(continued.backoffMs);
          continue;
        }
        return;
      }
    }

    await this.failRun(agent.id, run.id, "Recovery attempt limit exceeded", false);
  }

  private effectiveSettings() {
    return mergeSettings(
      this.config,
      this.store.snapshot().agentGuardSettings,
    );
  }

  getAgentGuardSettings(): AgentGuardSettingsResponse {
    return buildSettingsResponse(
      this.config,
      this.store.snapshot().agentGuardSettings,
    );
  }

  async updateAgentGuardSettings(
    patch: PatchAgentGuardSettingsInput,
  ): Promise<AgentGuardSettingsResponse> {
    return this.store.mutate((database) => {
      const nextOverrides = applyPatch(database.agentGuardSettings, patch);
      validateEffectiveRatios(this.config, nextOverrides);
      database.agentGuardSettings = nextOverrides;
      return buildSettingsResponse(this.config, database.agentGuardSettings);
    });
  }

  async resetAgentGuardSettings(): Promise<AgentGuardSettingsResponse> {
    return this.store.mutate((database) => {
      database.agentGuardSettings = null;
      return buildSettingsResponse(this.config, null);
    });
  }

  private budgetEstimates(): BudgetEstimates {
    const settings = this.effectiveSettings();
    return {
      softRatio: settings.softRatio,
      strictRatio: settings.strictRatio,
      estModelTokens: settings.estModelTokens,
      estToolTokens: settings.estToolTokens,
      charsPerToken: settings.charsPerToken,
      nextTurnEstimate: settings.nextTurnEstimate,
    };
  }

  private recentEventSummaries(runId: string): string[] {
    return eventsForRun(this.store, runId)
      .filter(
        (event) =>
          event.type === "MODEL_CALL" ||
          event.type === "TOOL_CALL" ||
          event.type === "ERROR" ||
          event.type.startsWith("BUDGET_"),
      )
      .slice(-8)
      .map((event) => summarizeTraceEvent(event));
  }

  private async prepareTurnPrompt(input: {
    run: AgentRun;
    originalPrompt: string;
    turnPrompt: string;
    estimates: BudgetEstimates;
    lastEmittedTier: BudgetTier | "none";
    preTurnBlockedOnce: boolean;
    trace: TraceContext;
  }): Promise<
    | {
        action: "ok";
        turnPrompt: string;
        promptForRunner: string;
        lastEmittedTier: BudgetTier | "none";
        preTurnBlockedOnce: boolean;
      }
    | {
        action: "awaiting_approval";
        incidentId: string;
      }
  > {
    const { run, estimates } = input;
    if (run.tokenBudget <= 0) {
      return {
        action: "ok",
        turnPrompt: input.turnPrompt,
        promptForRunner: input.turnPrompt,
        lastEmittedTier: input.lastEmittedTier,
        preTurnBlockedOnce: input.preTurnBlockedOnce,
      };
    }

    let turnPrompt = input.turnPrompt;
    let lastEmittedTier = input.lastEmittedTier;
    let preTurnBlockedOnce = input.preTurnBlockedOnce;
    const tier = budgetTier(run.tokensUsed, run.tokenBudget, estimates);

    if (shouldBlockPreTurn(run.tokensUsed, run.tokenBudget, estimates)) {
      if (preTurnBlockedOnce) {
        await appendTraceEvent(this.store, {
          runId: run.id,
          type: "BUDGET_EXCEEDED",
          status: "error",
          parentEventId: input.trace.runSpanId,
          attemptIndex: input.trace.attemptIndex,
          metadata: {
            reason: "pre_turn_block",
            tokensUsed: run.tokensUsed,
            tokenBudget: run.tokenBudget,
          },
        });
        const recovered = await this.handleFailure({
          agent: this.getAgent(run.agentId),
          run,
          injected: "budget_exceeded",
          timedOut: false,
          cancelled: false,
          message:
            "Pre-turn budget block: " + run.tokensUsed + "/" + run.tokenBudget,
          trace: input.trace,
        });
        if (recovered.action === "awaiting_approval") {
          return { action: "awaiting_approval", incidentId: recovered.incidentId };
        }
        return {
          action: "ok",
          turnPrompt,
          promptForRunner: turnPrompt,
          lastEmittedTier,
          preTurnBlockedOnce,
        };
      }
      preTurnBlockedOnce = true;
      turnPrompt = wrapPrompt({
        prompt: input.originalPrompt,
        tokensUsed: run.tokensUsed,
        tokenBudget: run.tokenBudget,
        tier: "strict",
        recentEventSummaries: this.recentEventSummaries(run.id),
      });
      await appendTraceEvent(this.store, {
        runId: run.id,
        type: "BUDGET_COMPRESSED",
        status: "ok",
        parentEventId: input.trace.runSpanId,
        attemptIndex: input.trace.attemptIndex,
        metadata: { reason: "pre_turn_block", tier: "strict" },
      });
      return {
        action: "ok",
        turnPrompt,
        promptForRunner: turnPrompt,
        lastEmittedTier: "strict",
        preTurnBlockedOnce,
      };
    }

    if (tier !== "normal" && lastEmittedTier !== tier) {
      await appendTraceEvent(this.store, {
        runId: run.id,
        type: "BUDGET_SOFT_LIMIT",
        status: "ok",
        parentEventId: input.trace.runSpanId,
        attemptIndex: input.trace.attemptIndex,
        metadata: {
          tier,
          tokensUsed: run.tokensUsed,
          tokenBudget: run.tokenBudget,
        },
      });
      lastEmittedTier = tier;
    }

    const promptForRunner = wrapPrompt({
      prompt: turnPrompt,
      tokensUsed: run.tokensUsed,
      tokenBudget: run.tokenBudget,
      tier,
      recentEventSummaries: this.recentEventSummaries(run.id),
    });
    return {
      action: "ok",
      turnPrompt,
      promptForRunner,
      lastEmittedTier,
      preTurnBlockedOnce,
    };
  }

  private async applyRecoveryContinuation(input: {
    recovered:
      | { action: "done" }
      | {
          action: "retry" | "restart_resume" | "compress_resume";
          attemptId: string;
          backoffMs: number;
        }
      | {
          action: "awaiting_approval";
          incidentId: string;
          failureType: import("./types.js").FailureType;
        };
    agent: Agent;
    run: AgentRun;
    pendingVerifyAttemptId: string | null;
    originalPrompt: string;
    trace: TraceContext;
  }): Promise<{
    outcome: "continue" | "return";
    agent: Agent;
    turnPrompt: string;
    pendingVerifyAttemptId: string | null;
    backoffMs?: number;
  }> {
    const { recovered, run, originalPrompt } = input;
    let agent = input.agent;
    let pendingVerifyAttemptId = input.pendingVerifyAttemptId;

    if (recovered.action === "awaiting_approval") {
      const decision = await this.waitForApproval(run.id, recovered.incidentId);
      if (decision === "abort") {
        await abortIncident(
          this.store,
          recovered.incidentId,
          "Operator denied recovery",
          this.traceOptionsForIncident(recovered.incidentId),
        );
        await this.failRun(agent.id, run.id, "Recovery denied by operator", false);
        return {
          outcome: "return",
          agent,
          turnPrompt: originalPrompt,
          pendingVerifyAttemptId,
        };
      }
      if (recovered.failureType === "budget_exceeded") {
        await this.raiseTokenBudget(run.id, recovered.incidentId);
        return {
          outcome: "continue",
          agent: this.getAgent(agent.id),
          turnPrompt: originalPrompt,
          pendingVerifyAttemptId: null,
        };
      }
      const afterApprove = await this.performApprovedRecovery({
        agent,
        run: this.getRun(run.id),
        incidentId: recovered.incidentId,
        failureType: recovered.failureType,
      });
      if (
        afterApprove.action === "retry" ||
        afterApprove.action === "restart_resume" ||
        afterApprove.action === "compress_resume"
      ) {
        return {
          outcome: "continue",
          agent: this.getAgent(agent.id),
          turnPrompt: this.promptForRecoveryAction(afterApprove.action, originalPrompt, run.id),
          pendingVerifyAttemptId: afterApprove.attemptId,
        };
      }
      return {
        outcome: "return",
        agent,
        turnPrompt: originalPrompt,
        pendingVerifyAttemptId,
      };
    }

    if (
      recovered.action === "retry" ||
      recovered.action === "restart_resume" ||
      recovered.action === "compress_resume"
    ) {
      if (recovered.action === "compress_resume") {
        await appendTraceEvent(this.store, {
          runId: run.id,
          type: "BUDGET_COMPRESSED",
          status: "ok",
          parentEventId: input.trace.runSpanId,
          attemptIndex: input.trace.attemptIndex,
          metadata: { reason: "compress_resume" },
        });
        return {
          outcome: "continue",
          agent: this.getAgent(agent.id),
          turnPrompt: originalPrompt,
          pendingVerifyAttemptId: recovered.attemptId,
          backoffMs: recovered.backoffMs,
        };
      }
      return {
        outcome: "continue",
        agent: this.getAgent(agent.id),
        turnPrompt: this.promptForRecoveryAction(recovered.action, originalPrompt, run.id),
        pendingVerifyAttemptId: recovered.attemptId,
        backoffMs: recovered.backoffMs,
      };
    }

    return {
      outcome: "return",
      agent,
      turnPrompt: originalPrompt,
      pendingVerifyAttemptId,
    };
  }

  private promptForRecoveryAction(
    action: "retry" | "restart_resume" | "compress_resume",
    originalPrompt: string,
    _runId: string,
  ): string {
    if (action === "retry") return originalPrompt;
    if (action === "compress_resume") return originalPrompt;
    return "Resume the previous task after a runtime interruption. Continue from the latest workspace state.";
  }

  private async checkpointAfterSpan(
    agentId: string,
    runId: string,
    boundary: string,
    parentEventId: string | null,
    attemptIndex: number,
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
      parentEventId,
      attemptIndex,
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
    budgetProjectedExceeded?: boolean;
    trace: TraceContext;
  }): Promise<
    | { action: "done" }
    | {
        action: "retry" | "restart_resume" | "compress_resume";
        attemptId: string;
        backoffMs: number;
      }
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
      parentEventId:
        input.trace.failingSpanId ?? input.trace.turnSpanId ?? input.trace.runSpanId,
      attemptIndex: input.trace.attemptIndex,
      error: input.message,
      metadata: { injected: input.injected },
    });
    input.trace.failingSpanId = errorEvent.id;
    const failureTrace = {
      parentEventId: input.trace.failingSpanId,
      attemptIndex: input.trace.attemptIndex,
    };
    const failureType = classifyFailure({
      injected: input.injected,
      timedOut: input.timedOut,
      cancelled: input.cancelled,
      budgetExceeded: input.injected === "budget_exceeded",
      budgetProjectedExceeded:
        input.budgetProjectedExceeded ||
        input.injected === "budget_projected_exceeded",
      message: input.message,
    });
    const incident = await openIncident(this.store, {
      runId: input.run.id,
      eventId: errorEvent.id,
      failureType,
      severity: severityFor(failureType),
      parentEventId: input.trace.failingSpanId,
      attemptIndex: input.trace.attemptIndex,
    });

    const strategy = selectStrategy(failureType);
    await issueDiagnosis(this.store, {
      runId: input.run.id,
      incidentId: incident.id,
      signals: {
        injected: input.injected,
        timedOut: input.timedOut,
        cancelled: input.cancelled,
        budgetExceeded:
          input.injected === "budget_exceeded" || failureType === "budget_exceeded",
        budgetProjectedExceeded:
          input.budgetProjectedExceeded ||
          input.injected === "budget_projected_exceeded",
        message: input.message,
        tokensUsed: input.run.tokensUsed,
        tokenBudget: input.run.tokenBudget,
      },
      strategy,
      strategyRationale: strategyRationaleFor(failureType, strategy),
      parentEventId: input.trace.failingSpanId,
      attemptIndex: input.trace.attemptIndex,
    });
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
        failureTrace,
      );
      return {
        action: "awaiting_approval",
        incidentId: incident.id,
        failureType,
      };
    }

    if (failureType === "budget_projected_exceeded") {
      if (
        shouldAbortAfterAttempts(
          failureType,
          priorAttempts,
          this.effectiveSettings().maxCompressRecoveries,
        )
      ) {
        await requestApproval(
          this.store,
          incident,
          "Budget compress recoveries exhausted; approve to raise budget or abort",
          failureTrace,
        );
        return {
          action: "awaiting_approval",
          incidentId: incident.id,
          failureType: "budget_exceeded",
        };
      }
      return this.startCheckpointedRecovery({
        agent: input.agent,
        run: input.run,
        incident,
        strategy: "compress_resume",
        priorAttempts,
        errorEventId: errorEvent.id,
        ...failureTrace,
      });
    }

    if (
      failureType === "runtime_crash" &&
      requiresApprovalForCrash(
        priorCrashRecoveries,
        this.effectiveSettings().requireApprovalAfterCrashes,
      )
    ) {
      await requestApproval(
        this.store,
        incident,
        "Additional crash recovery requires operator approval",
        failureTrace,
      );
      return {
        action: "awaiting_approval",
        incidentId: incident.id,
        failureType,
      };
    }

    if (
      strategy === "abort" ||
      shouldAbortAfterAttempts(
        failureType,
        priorAttempts,
        this.effectiveSettings().maxCompressRecoveries,
      )
    ) {
      await abortIncident(
        this.store,
        incident.id,
        "Recovery policy aborted: " + failureType,
        failureTrace,
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
        parentEventId: input.trace.runSpanId,
        attemptIndex: input.trace.attemptIndex,
        error: input.message,
      });
      return { action: "done" };
    }

    if (
      strategy === "restart_resume" ||
      strategy === "retry" ||
      strategy === "compress_resume"
    ) {
      return this.startCheckpointedRecovery({
        agent: input.agent,
        run: input.run,
        incident,
        strategy,
        priorAttempts,
        errorEventId: errorEvent.id,
        ...failureTrace,
      });
    }

    await abortIncident(
      this.store,
      incident.id,
      "No recovery strategy",
      failureTrace,
    );
    return { action: "done" };
  }

  private async startCheckpointedRecovery(input: {
    agent: Agent;
    run: AgentRun;
    incident: Incident;
    strategy: "retry" | "restart_resume" | "compress_resume";
    priorAttempts: number;
    errorEventId: string;
    parentEventId: string | null;
    attemptIndex: number;
  }): Promise<
    | { action: "done" }
    | {
        action: "retry" | "restart_resume" | "compress_resume";
        attemptId: string;
        backoffMs: number;
      }
  > {
    const checkpoint = this.latestCheckpoint(input.run.id);
    if (!checkpoint) {
      await abortIncident(
        this.store,
        input.incident.id,
        "No checkpoint available for " + input.strategy,
        {
          parentEventId: input.parentEventId,
          attemptIndex: input.attemptIndex,
        },
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
      parentEventId: input.parentEventId,
      attemptIndex: input.attemptIndex,
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
      const workspaceFiles = await listSnapshotEntries(
        checkpoint.workspaceSnapshotRef,
      ).catch(() => []);
      const restoredRun = this.getRun(input.run.id);
      const stateDelta: DiagnosisStateDelta = {
        checkpointId: checkpoint.id,
        workspaceFiles: workspaceFiles.length,
        codexThreadReattached: checkpoint.codexThreadId !== null,
        backoffMs: retryBackoffMs(input.priorAttempts + 1),
        tokensUsed: restoredRun.tokensUsed,
        tokenBudget: restoredRun.tokenBudget,
        degraded: input.strategy === "compress_resume",
      };
      await updateDiagnosis(
        this.store,
        input.incident.id,
        {
          status: "acted",
          stateDelta,
        },
        {
          parentEventId: input.parentEventId,
          attemptIndex: input.attemptIndex,
        },
      );
      await completeRecoveryAttempt(this.store, attempt.id, "succeeded", null, {
        parentEventId: input.parentEventId,
        attemptIndex: input.attemptIndex,
      });
      return {
        action: input.strategy,
        attemptId: attempt.id,
        backoffMs: retryBackoffMs(input.priorAttempts + 1),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeRecoveryAttempt(this.store, attempt.id, "failed", message, {
        parentEventId: input.parentEventId,
        attemptIndex: input.attemptIndex,
      });
      await abortIncident(this.store, input.incident.id, message, {
        parentEventId: input.parentEventId,
        attemptIndex: input.attemptIndex,
      });
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
    | {
        action: "retry" | "restart_resume" | "compress_resume";
        attemptId: string;
        backoffMs: number;
      }
  > {
    const incident = this.store
      .snapshot()
      .incidents.find((item) => item.id === input.incidentId);
    if (!incident) return { action: "done" };
    const trace = this.traceOptionsForIncident(incident.id);
    const strategy =
      input.failureType === "budget_exceeded"
        ? "abort"
        : selectStrategy(input.failureType);
    if (strategy === "abort") {
      await abortIncident(
        this.store,
        incident.id,
        "Approved path still aborts",
        trace,
      );
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
      ...trace,
    });
  }

  private async raiseTokenBudget(runId: string, incidentId: string): Promise<void> {
    const incidentTrace = this.traceOptionsForIncident(incidentId);
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const incident = database.incidents.find((item) => item.id === incidentId);
      if (storedRun) {
        storedRun.tokenBudget =
          storedRun.tokensUsed + this.effectiveSettings().tokenBudget;
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
      parentEventId: this.runSpanId(runId),
      attemptIndex: incidentTrace.attemptIndex,
      metadata: { incidentId, raisedBudget: true },
    });
    await updateDiagnosis(
      this.store,
      incidentId,
      { status: "verified" },
      incidentTrace,
    );
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

  private traceOptionsForIncident(incidentId: string): {
    parentEventId: string | null;
    attemptIndex: number;
  } {
    const incident = this.store
      .snapshot()
      .incidents.find((item) => item.id === incidentId);
    const failingEvent = this.store
      .snapshot()
      .events.find((event) => event.id === incident?.eventId);
    return {
      parentEventId: incident?.eventId ?? null,
      attemptIndex: failingEvent?.attemptIndex ?? 0,
    };
  }

  private runSpanId(runId: string): string | null {
    return (
      this.store
        .snapshot()
        .events.find((event) => event.runId === runId && event.type === "RUN_STARTED")
        ?.id ?? null
    );
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
