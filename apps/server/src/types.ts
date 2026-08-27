export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "recovering"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

export type IncidentStatus =
  | "open"
  | "recovering"
  | "resolved"
  | "aborted"
  | "awaiting_approval";
export type RecoveryStatus = "started" | "succeeded" | "failed" | "verified";
export type FailureType =
  | "runtime_crash"
  | "tool_timeout"
  | "transient_tool_error"
  | "budget_exceeded"
  | "budget_projected_exceeded"
  | "unknown";
export type RecoveryStrategy = "retry" | "restart_resume" | "compress_resume" | "abort";
export type EventType =
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "MODEL_CALL"
  | "TOOL_CALL"
  | "CHECKPOINT_CREATED"
  | "ERROR"
  | "INCIDENT_OPENED"
  | "DIAGNOSIS_ISSUED"
  | "DIAGNOSIS_VERDICT"
  | "RECOVERY_STARTED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_FAILED"
  | "RECOVERY_VERIFIED"
  | "ALERT"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_DENIED"
  | "BUDGET_SOFT_LIMIT"
  | "BUDGET_PROJECTED_EXCEED"
  | "BUDGET_COMPRESSED"
  | "BUDGET_EXCEEDED"
  | "BUDGET_RAISED";
export type EventStatus = "ok" | "error" | "running";
export type Severity = "low" | "medium" | "high";
export type DiagnosisStatus =
  | "issued"
  | "acted"
  | "awaiting_approval"
  | "verified"
  | "aborted";
export type InjectFailType =
  | "runtime_crash"
  | "tool_timeout"
  | "budget_exceeded"
  | "budget_projected_exceeded";
export type ApprovalDecision = "approve" | "abort";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  recoveryAttemptCount: number;
  tokensUsed: number;
  tokenBudget: number;
  pendingApprovalIncidentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TraceEvent {
  id: string;
  runId: string;
  parentEventId: string | null;
  type: EventType;
  status: EventStatus;
  timestamp: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  error: string | null;
}

export interface Incident {
  id: string;
  runId: string;
  eventId: string;
  failureType: FailureType;
  severity: Severity;
  status: IncidentStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RecoveryAttempt {
  id: string;
  incidentId: string;
  runId: string;
  strategy: RecoveryStrategy;
  status: RecoveryStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

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
  failureType: FailureType;
  severity: Severity;
  summary: string;
  rootCause: string;
  confidence: number;
  evidence: DiagnosisEvidence[];
  strategy: RecoveryStrategy | null;
  strategyRationale: string | null;
  stateDelta: DiagnosisStateDelta | null;
  status: DiagnosisStatus;
  signature: string;
  recurrenceCount: number;
  suggestions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  runId: string;
  agentId: string;
  codexThreadId: string | null;
  workspaceSnapshotRef: string;
  boundary: string;
  createdAt: string;
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

export interface Database {
  version: 3;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  events: TraceEvent[];
  incidents: Incident[];
  recoveryAttempts: RecoveryAttempt[];
  diagnoses: DiagnosisRecord[];
  checkpoints: Checkpoint[];
  agentGuardSettings: AgentGuardSettingsOverrides | null;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  timedOut?: boolean;
}

export interface RunnerStreamEvent {
  type: EventType;
  status: EventStatus;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onEvent?: (event: RunnerStreamEvent) => void | Promise<void>;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
