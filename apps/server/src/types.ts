export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

export type IncidentStatus = "open" | "recovering" | "resolved" | "aborted";
export type RecoveryStatus = "started" | "succeeded" | "failed" | "verified";
export type FailureType =
  | "runtime_crash"
  | "tool_timeout"
  | "transient_tool_error"
  | "unknown";
export type RecoveryStrategy = "retry" | "restart_resume" | "abort";
export type EventType =
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "MODEL_CALL"
  | "TOOL_CALL"
  | "CHECKPOINT_CREATED"
  | "ERROR"
  | "INCIDENT_OPENED"
  | "RECOVERY_STARTED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_FAILED"
  | "RECOVERY_VERIFIED"
  | "ALERT";
export type EventStatus = "ok" | "error" | "running";
export type Severity = "low" | "medium" | "high";
export type InjectFailType = "runtime_crash" | "tool_timeout";

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

export interface Checkpoint {
  id: string;
  runId: string;
  agentId: string;
  codexThreadId: string | null;
  workspaceSnapshotRef: string;
  boundary: string;
  createdAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  events: TraceEvent[];
  incidents: Incident[];
  recoveryAttempts: RecoveryAttempt[];
  checkpoints: Checkpoint[];
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
