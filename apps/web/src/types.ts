export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "recovering"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  recoveryAttemptCount?: number;
  tokensUsed?: number;
  tokenBudget?: number;
  pendingApprovalIncidentId?: string | null;
  createdAt: string;
}

export interface TraceEvent {
  id: string;
  runId: string;
  parentEventId: string | null;
  type: string;
  status: string;
  timestamp: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  error: string | null;
}

export interface Incident {
  id: string;
  runId: string;
  eventId: string;
  failureType: string;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RecoveryAttempt {
  id: string;
  incidentId: string;
  runId: string;
  strategy: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type DiagnosisStatus =
  | "issued"
  | "acted"
  | "awaiting_approval"
  | "verified"
  | "aborted";

export interface DiagnosisEvidence {
  signal: string;
  value: string;
  matched: string;
}

export interface DiagnosisStateDelta {
  checkpointId: string;
  workspaceFiles: number;
  codexThreadReattached: boolean;
  backoffMs: number | null;
  tokensUsed: number;
  tokenBudget: number;
  degraded: boolean;
}

export interface DiagnosisRecord {
  id: string;
  runId: string;
  incidentId: string;
  failureType: string;
  severity: string;
  summary: string;
  rootCause: string;
  confidence: number;
  evidence: DiagnosisEvidence[];
  strategy: string | null;
  strategyRationale: string | null;
  stateDelta: DiagnosisStateDelta | null;
  status: DiagnosisStatus;
  signature: string;
  recurrenceCount: number;
  suggestions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  middleware?: string;
  agentGuardTokenBudget?: number;
}

export interface AgentGuardSettingsOverrides {
  tokenBudget?: number;
  softRatio?: number;
  strictRatio?: number;
  estModelTokens?: number;
  estToolTokens?: number;
  charsPerToken?: number;
  nextTurnEstimate?: number;
  maxCompressRecoveries?: number;
  requireApprovalAfterCrashes?: number;
}

export interface AgentGuardSettingsEffective {
  tokenBudget: number;
  softRatio: number;
  strictRatio: number;
  estModelTokens: number;
  estToolTokens: number;
  charsPerToken: number;
  nextTurnEstimate: number;
  maxCompressRecoveries: number;
  requireApprovalAfterCrashes: number;
}

export interface AgentGuardSettingsResponse {
  defaults: AgentGuardSettingsEffective;
  overrides: AgentGuardSettingsOverrides | null;
  effective: AgentGuardSettingsEffective;
}
