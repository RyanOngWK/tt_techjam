import type {
  Agent,
  AgentRun,
  AgentGuardSettingsOverrides,
  AgentGuardSettingsResponse,
  DiagnosisRecord,
  Incident,
  Message,
  RecoveryAttempt,
  RunListItem,
  SpanNode,
  SystemInfo,
  TraceEvent,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  events: (runId: string) =>
    request<{ events: TraceEvent[] }>("/api/runs/" + runId + "/events"),
  listRuns: () => request<{ runs: RunListItem[] }>("/api/runs"),
  spanTree: (runId: string, query?: string) =>
    request<{ events: SpanNode[] }>(
      "/api/runs/" + runId + "/events?tree=true" + (query ? "&" + query : ""),
    ),
  incidents: (runId?: string) =>
    request<{ incidents: Incident[] }>(
      "/api/incidents" + (runId ? "?runId=" + runId : ""),
    ),
  recoveries: (runId: string) =>
    request<{ recoveries: RecoveryAttempt[] }>("/api/runs/" + runId + "/recoveries"),
  diagnoses: (runId: string) =>
    request<{ diagnoses: DiagnosisRecord[] }>("/api/runs/" + runId + "/diagnoses"),
  injectFailure: (
    runId: string,
    type:
      | "runtime_crash"
      | "tool_timeout"
      | "budget_exceeded"
      | "budget_projected_exceeded",
  ) =>
    request<{ ok: true }>("/api/runs/" + runId + "/fail", {
      method: "POST",
      body: JSON.stringify({ type }),
    }),
  resolveApproval: (runId: string, decision: "approve" | "abort") =>
    request<{ ok: true; decision: "approve" | "abort" }>(
      "/api/runs/" + runId + "/approve",
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      },
    ),
  getAgentGuardSettings: () =>
    request<AgentGuardSettingsResponse>("/api/agentguard/settings"),
  updateAgentGuardSettings: (body: AgentGuardSettingsOverrides) =>
    request<AgentGuardSettingsResponse>("/api/agentguard/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  resetAgentGuardSettings: () =>
    request<AgentGuardSettingsResponse>("/api/agentguard/settings/reset", {
      method: "POST",
    }),
  exportEventsUrl: (runId: string) => "/api/runs/" + runId + "/events?format=download",
};
