import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type {
  FailureType,
  Incident,
  RecoveryAttempt,
  RecoveryStrategy,
  Severity,
} from "../types.js";
import { updateDiagnosis } from "./diagnostic.js";
import { appendTraceEvent } from "./trace-collector.js";

const now = () => new Date().toISOString();

export async function openIncident(
  store: JsonStore,
  input: {
    runId: string;
    eventId: string;
    failureType: FailureType;
    severity: Severity;
  },
): Promise<Incident> {
  const incident: Incident = {
    id: randomUUID(),
    runId: input.runId,
    eventId: input.eventId,
    failureType: input.failureType,
    severity: input.severity,
    status: "open",
    createdAt: now(),
    resolvedAt: null,
  };
  await store.mutate((database) => {
    database.incidents.push(incident);
  });
  await appendTraceEvent(store, {
    runId: input.runId,
    type: "INCIDENT_OPENED",
    status: "error",
    metadata: {
      incidentId: incident.id,
      failureType: incident.failureType,
    },
  });
  return incident;
}

export async function startRecoveryAttempt(
  store: JsonStore,
  input: {
    incident: Incident;
    strategy: RecoveryStrategy;
    metadata?: Record<string, unknown>;
  },
): Promise<RecoveryAttempt> {
  const attempt: RecoveryAttempt = {
    id: randomUUID(),
    incidentId: input.incident.id,
    runId: input.incident.runId,
    strategy: input.strategy,
    status: "started",
    startedAt: now(),
    completedAt: null,
    error: null,
  };
  await store.mutate((database) => {
    const incident = database.incidents.find((item) => item.id === input.incident.id);
    if (incident) incident.status = "recovering";
    const run = database.runs.find((item) => item.id === input.incident.runId);
    if (run) {
      run.status = "recovering";
      run.recoveryAttemptCount += 1;
    }
    database.recoveryAttempts.push(attempt);
  });
  await appendTraceEvent(store, {
    runId: input.incident.runId,
    type: "RECOVERY_STARTED",
    status: "running",
    metadata: {
      attemptId: attempt.id,
      strategy: attempt.strategy,
      incidentId: attempt.incidentId,
      recoveryAttemptId: attempt.id,
      ...(input.metadata ?? {}),
    },
  });
  return attempt;
}

export async function completeRecoveryAttempt(
  store: JsonStore,
  attemptId: string,
  outcome: "succeeded" | "failed",
  error?: string | null,
): Promise<RecoveryAttempt | null> {
  const completedAt = now();
  const attempt = await store.mutate((database) => {
    const stored = database.recoveryAttempts.find((item) => item.id === attemptId);
    if (!stored) return null;
    stored.status = outcome;
    stored.completedAt = completedAt;
    stored.error = error ?? null;
    return structuredClone(stored);
  });
  if (!attempt) return null;
  await appendTraceEvent(store, {
    runId: attempt.runId,
    type: outcome === "succeeded" ? "RECOVERY_COMPLETED" : "RECOVERY_FAILED",
    status: outcome === "succeeded" ? "ok" : "error",
    metadata: { attemptId, strategy: attempt.strategy },
    error: error ?? null,
  });
  return attempt;
}

export async function verifyRecovery(
  store: JsonStore,
  attemptId: string,
): Promise<void> {
  const attempt = await store.mutate((database) => {
    const stored = database.recoveryAttempts.find((item) => item.id === attemptId);
    if (!stored) return null;
    stored.status = "verified";
    if (!stored.completedAt) stored.completedAt = now();
    const incident = database.incidents.find((item) => item.id === stored.incidentId);
    if (incident) {
      incident.status = "resolved";
      incident.resolvedAt = now();
    }
    return structuredClone(stored);
  });
  if (!attempt) return;
  await appendTraceEvent(store, {
    runId: attempt.runId,
    type: "RECOVERY_VERIFIED",
    status: "ok",
    metadata: {
      attemptId: attempt.id,
      incidentId: attempt.incidentId,
    },
  });
  await updateDiagnosis(store, attempt.incidentId, { status: "verified" });
}

export async function abortIncident(
  store: JsonStore,
  incidentId: string,
  reason: string,
): Promise<void> {
  const incident = await store.mutate((database) => {
    const stored = database.incidents.find((item) => item.id === incidentId);
    if (!stored) return null;
    stored.status = "aborted";
    stored.resolvedAt = now();
    const run = database.runs.find((item) => item.id === stored.runId);
    if (run) {
      run.status = "failed";
      run.error = reason;
      run.completedAt = now();
      run.pendingApprovalIncidentId = null;
    }
    return structuredClone(stored);
  });
  if (!incident) return;
  await appendTraceEvent(store, {
    runId: incident.runId,
    type: "ALERT",
    status: "error",
    metadata: { incidentId, reason },
    error: reason,
  });
  await updateDiagnosis(store, incidentId, { status: "aborted" });
}

export async function requestApproval(
  store: JsonStore,
  incident: Incident,
  reason: string,
): Promise<void> {
  await store.mutate((database) => {
    const stored = database.incidents.find((item) => item.id === incident.id);
    if (stored) stored.status = "awaiting_approval";
    const run = database.runs.find((item) => item.id === incident.runId);
    if (run) {
      run.status = "awaiting_approval";
      run.pendingApprovalIncidentId = incident.id;
    }
  });
  await appendTraceEvent(store, {
    runId: incident.runId,
    type: "APPROVAL_REQUESTED",
    status: "running",
    metadata: {
      incidentId: incident.id,
      failureType: incident.failureType,
      reason,
    },
    error: reason,
  });
  await updateDiagnosis(store, incident.id, { status: "awaiting_approval" });
}
