import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type {
  DiagnosisEvidence,
  DiagnosisRecord,
  DiagnosisStateDelta,
  DiagnosisStatus,
  FailureType,
  InjectFailType,
  RecoveryStrategy,
  Severity,
} from "../types.js";
import { classifyFailure, severityFor } from "./failure-detector.js";
import { redactString } from "./redact.js";
import { appendTraceEvent } from "./trace-collector.js";

const now = () => new Date().toISOString();

export interface FailureSignals {
  injected?: InjectFailType | null;
  timedOut?: boolean;
  cancelled?: boolean;
  budgetExceeded?: boolean;
  budgetProjectedExceeded?: boolean;
  message?: string | null;
  tokensUsed?: number;
  tokenBudget?: number;
}

export interface DiagnosisOutput {
  failureType: FailureType;
  severity: Severity;
  rootCause: string;
  confidence: number;
  evidence: DiagnosisEvidence[];
  signature: string;
  suggestions: string[];
}

const SIGNAL_CONFIDENCE: Record<string, number> = {
  injected_failure: 1.0,
  cancellation: 1.0,
  budget_usage: 0.95,
  exit_code: 0.9,
  termination_signal: 0.9,
  runner_timeout: 0.9,
  budget_projection: 0.9,
  network_transient: 0.85,
};

function buildEvidence(input: FailureSignals): DiagnosisEvidence[] {
  const evidence: DiagnosisEvidence[] = [];
  const message = (input.message ?? "").toLowerCase();
  if (input.injected) {
    evidence.push({
      signal: "injected_failure",
      value: input.injected,
      matched: "The failure was injected for controlled demonstration",
    });
  }
  if (input.cancelled) {
    evidence.push({
      signal: "cancellation",
      value: "operator_cancelled",
      matched: "Execution was cancelled by the operator",
    });
  }
  if (
    input.budgetProjectedExceeded ||
    /budget projected|projected exceed/i.test(message)
  ) {
    evidence.push({
      signal: "budget_projection",
      value:
        input.tokensUsed !== undefined && input.tokenBudget !== undefined
          ? input.tokensUsed + "/" + input.tokenBudget
          : "next-turn projection",
      matched: "Projected usage for the next turn exceeds the remaining token budget",
    });
  }
  if (input.budgetExceeded || /budget/i.test(message)) {
    if (!/projected|projection/i.test(message)) {
      evidence.push({
        signal: "budget_usage",
        value:
          input.tokensUsed !== undefined && input.tokenBudget !== undefined
            ? input.tokensUsed + "/" + input.tokenBudget
            : "over budget",
        matched: "Tokens used exceeded the configured token budget",
      });
    }
  }
  if (input.timedOut || /timed out|timeout/i.test(message)) {
    evidence.push({
      signal: "runner_timeout",
      value: "runner deadline exceeded",
      matched: "The Codex runner exceeded its configured timeout",
    });
  }
  const exitMatch = /exited with code\s+(-?\d+)/i.exec(input.message ?? "");
  if (exitMatch) {
    evidence.push({
      signal: "exit_code",
      value: exitMatch[1] ?? "",
      matched: "The runner process exited with a non-zero exit code",
    });
  }
  if (/crash|sigkill|sigterm/i.test(message)) {
    evidence.push({
      signal: "termination_signal",
      value: "process_terminated",
      matched: "The process was killed (SIGKILL/SIGTERM) or reported a crash",
    });
  }
  if (/econnreset|temporarily/i.test(message)) {
    evidence.push({
      signal: "network_transient",
      value: "connection_reset",
      matched: "A transient network or provider error interrupted the tool call",
    });
  }
  return evidence;
}

function rootCauseFor(
  failureType: FailureType,
  evidence: DiagnosisEvidence[],
): string {
  const exitCode = evidence.find((item) => item.signal === "exit_code")?.value;
  switch (failureType) {
    case "runtime_crash":
      return exitCode
        ? "The Codex process exited unexpectedly with code " +
            exitCode +
            (exitCode === "137"
              ? " (SIGKILL — commonly an out-of-memory termination)"
              : "") +
            " during execution."
        : "The Codex process was terminated or crashed during execution.";
    case "tool_timeout":
      return "A Codex tool call exceeded the runner timeout and was cut off mid-operation.";
    case "transient_tool_error":
      return "A transient provider or network error interrupted a tool call.";
    case "budget_exceeded":
      return "Token consumption crossed the configured budget (used/budget shown in evidence).";
    case "budget_projected_exceeded":
      return "The next turn was projected to exceed the remaining token budget before it started.";
    case "unknown":
      return "No known failure signature matched the observed signals; the error class is unrecognized.";
    default:
      return "An unexpected failure was detected.";
  }
}

function suggestionsFor(
  failureType: FailureType,
  evidence: DiagnosisEvidence[],
): string[] {
  const exitCode = evidence.find((item) => item.signal === "exit_code")?.value;
  switch (failureType) {
    case "runtime_crash":
      return exitCode === "137"
        ? [
            "Raise CONTAINER_MEMORY_LIMIT if the exit code 137 points to an out-of-memory kill.",
            "Reduce the number of large workspace file writes in a single turn.",
            "Confirm the runtime image is patched and up to date.",
          ]
        : [
            "Confirm the runtime image is patched and up to date.",
            "Reduce the number of large workspace file writes in a single turn.",
          ];
    case "tool_timeout":
      return [
        "Raise CODEX_TIMEOUT_MS if the task legitimately needs more time.",
        "Break the task into smaller steps to avoid long-running tool calls.",
        "Check provider or network latency for the tool endpoint.",
      ];
    case "transient_tool_error":
      return [
        "Automatic retry is applied; repeated occurrences may indicate provider instability.",
        "Verify ARK_BASE_URL reachability from the runtime.",
      ];
    case "budget_exceeded":
      return [
        "Raise AGENTGUARD_TOKEN_BUDGET for longer tasks.",
        "Tune AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE to catch overruns before they happen.",
        "Lower AGENTGUARD_BUDGET_SOFT_RATIO to compress context earlier.",
      ];
    case "budget_projected_exceeded":
      return [
        "Lower AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE if projections are too conservative.",
        "Increase the token budget or cap turns earlier for this Agent.",
      ];
    case "unknown":
      return [
        "Inspect the full trace export to locate the failing step.",
        "Enable verbose runner logs to capture the underlying error.",
      ];
    default:
      return [];
  }
}

export function signatureFor(
  failureType: FailureType,
  evidence: DiagnosisEvidence[],
): string {
  const exitCode = evidence.find((item) => item.signal === "exit_code")?.value;
  if (exitCode) return failureType + ":exit" + exitCode;
  return failureType;
}

export function diagnoseFailure(signals: FailureSignals): DiagnosisOutput {
  const failureType = classifyFailure({
    injected: signals.injected ?? null,
    timedOut: signals.timedOut ?? false,
    cancelled: signals.cancelled ?? false,
    budgetExceeded: signals.budgetExceeded ?? false,
    budgetProjectedExceeded: signals.budgetProjectedExceeded ?? false,
    message: signals.message ?? null,
  });
  const evidence = buildEvidence(signals).map((item) => ({
    signal: redactString(item.signal),
    value: redactString(item.value),
    matched: redactString(item.matched),
  }));
  const confidence =
    failureType === "unknown"
      ? 0.4
      : Math.max(0.5, ...evidence.map((item) => SIGNAL_CONFIDENCE[item.signal] ?? 0.5));
  return {
    failureType,
    severity: severityFor(failureType),
    rootCause: redactString(rootCauseFor(failureType, evidence)),
    confidence,
    evidence,
    signature: signatureFor(failureType, evidence),
    suggestions: suggestionsFor(failureType, evidence).map(redactString),
  };
}

export function summaryFor(
  failureType: FailureType,
  strategy: RecoveryStrategy | null,
): string {
  switch (failureType) {
    case "runtime_crash":
      return strategy === "restart_resume"
        ? "runtime crash detected — AgentGuard restored the workspace checkpoint and is resuming the session"
        : "runtime crash detected — no safe recovery available";
    case "tool_timeout":
      return "tool timeout detected — AgentGuard is retrying the turn";
    case "transient_tool_error":
      return "transient provider error detected — AgentGuard is retrying the turn";
    case "budget_projected_exceeded":
      return "budget projection exceeded — AgentGuard is compressing context to stay within budget";
    case "budget_exceeded":
      return "token budget exceeded — recovery requires operator approval";
    case "unknown":
      return "unknown failure — AgentGuard is aborting with an alert";
    default:
      return failureType + " detected";
  }
}

export async function issueDiagnosis(
  store: JsonStore,
  input: {
    runId: string;
    incidentId: string;
    signals: FailureSignals;
    strategy: RecoveryStrategy | null;
    strategyRationale: string | null;
    parentEventId?: string | null;
    attemptIndex?: number;
  },
): Promise<DiagnosisRecord> {
  const diagnosis = diagnoseFailure(input.signals);
  const priorSameSignature = store
    .snapshot()
    .diagnoses.filter(
      (item) =>
        item.runId === input.runId && item.signature === diagnosis.signature,
    ).length;
  const record: DiagnosisRecord = {
    id: randomUUID(),
    runId: input.runId,
    incidentId: input.incidentId,
    failureType: diagnosis.failureType,
    severity: diagnosis.severity,
    summary: summaryFor(diagnosis.failureType, input.strategy),
    rootCause: diagnosis.rootCause,
    confidence: diagnosis.confidence,
    evidence: diagnosis.evidence,
    strategy: input.strategy,
    strategyRationale: input.strategyRationale,
    stateDelta: null,
    status: "issued",
    signature: diagnosis.signature,
    recurrenceCount: priorSameSignature,
    suggestions: diagnosis.suggestions,
    createdAt: now(),
    updatedAt: now(),
  };
  await store.mutate((database) => {
    database.diagnoses.push(record);
  });
  await appendTraceEvent(store, {
    runId: input.runId,
    type: "DIAGNOSIS_ISSUED",
    status: "error",
    parentEventId: input.parentEventId ?? null,
    attemptIndex: input.attemptIndex ?? 0,
    metadata: {
      diagnosisId: record.id,
      incidentId: record.incidentId,
      failureType: record.failureType,
      severity: record.severity,
      confidence: record.confidence,
      signature: record.signature,
      recurrenceCount: record.recurrenceCount,
    },
  });
  return record;
}

export async function updateDiagnosis(
  store: JsonStore,
  incidentId: string,
  patch: {
    status?: DiagnosisStatus;
    stateDelta?: DiagnosisStateDelta | null;
    strategyRationale?: string | null;
    summary?: string;
  },
  trace?: {
    parentEventId?: string | null;
    attemptIndex?: number;
  },
): Promise<DiagnosisRecord | null> {
  const updated = await store.mutate((database) => {
    const stored = database.diagnoses.find(
      (item) => item.incidentId === incidentId,
    );
    if (!stored) return null;
    if (patch.status !== undefined) stored.status = patch.status;
    if (patch.stateDelta !== undefined) stored.stateDelta = patch.stateDelta;
    if (patch.strategyRationale !== undefined) {
      stored.strategyRationale = patch.strategyRationale;
    }
    if (patch.summary !== undefined) stored.summary = patch.summary;
    stored.updatedAt = now();
    return structuredClone(stored);
  });
  if (!updated) return null;
  if (updated.status === "verified" || updated.status === "aborted") {
    await appendTraceEvent(store, {
      runId: updated.runId,
      type: "DIAGNOSIS_VERDICT",
      status: updated.status === "verified" ? "ok" : "error",
      parentEventId: trace?.parentEventId ?? null,
      attemptIndex: trace?.attemptIndex ?? 0,
      metadata: {
        diagnosisId: updated.id,
        incidentId: updated.incidentId,
        status: updated.status,
      },
      error:
        updated.status === "aborted"
          ? "Recovery did not resolve the incident"
          : null,
    });
  }
  return updated;
}

export function diagnosesForRun(
  store: JsonStore,
  runId: string,
): DiagnosisRecord[] {
  return store
    .snapshot()
    .diagnoses.filter((item) => item.runId === runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
