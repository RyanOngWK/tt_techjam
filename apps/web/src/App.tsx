import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import {
  clampRect,
  loadGeometry,
  resizeFromCorner,
  saveGeometry,
  type ResizeCorner,
  type WindowGeometry,
} from "./agentguard-window";
import { AgentGuardSettingsModal } from "./AgentGuardSettingsModal";
import type {
  Agent,
  AgentRun,
  AgentGuardSettingsEffective,
  DiagnosisRecord,
  Incident,
  Message,
  RecoveryAttempt,
  SystemInfo,
  TraceEvent,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

const ACTIVE_RUN_STATUSES = ["queued", "running", "recovering", "awaiting_approval"] as const;

function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveryAttempt[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [agentGuardOpen, setAgentGuardOpen] = useState(false);
  const [agentGuardDismissedRunId, setAgentGuardDismissedRunId] = useState<string | null>(
    null,
  );
  const [showAgentGuardSettings, setShowAgentGuardSettings] = useState(false);
  const [budgetPolicy, setBudgetPolicy] = useState<AgentGuardSettingsEffective | null>(
    null,
  );
  const [windowGeometry, setWindowGeometry] = useState<WindowGeometry>(() => loadGeometry());
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const dragSession = useRef<
    | {
        mode: "move";
        startX: number;
        startY: number;
        origin: WindowGeometry;
      }
    | {
        mode: "resize";
        corner: ResizeCorner;
        startX: number;
        startY: number;
        origin: WindowGeometry;
      }
    | null
  >(null);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      api
        .getAgentGuardSettings()
        .then((response) => setBudgetPolicy(response.effective))
        .catch(() => undefined),
    ]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setTraceEvents([]);
    setIncidents([]);
    setRecoveries([]);
    setDiagnoses([]);
    setShowSettings(false);
    setAgentGuardOpen(false);
    setAgentGuardDismissedRunId(null);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest) {
          void refreshAgentGuard(latest.id).catch(() => undefined);
        }
        if (latest && ["queued", "running", "recovering", "awaiting_approval"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    if (!activeRun || !isActiveRunStatus(activeRun.status)) return;
    if (agentGuardDismissedRunId === activeRun.id) return;
    setAgentGuardOpen(true);
  }, [activeRun, agentGuardDismissedRunId]);

  useEffect(() => {
    const onResize = () => {
      setWindowGeometry((current) => {
        const next = clampRect(current);
        saveGeometry(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = dragSession.current;
      if (!session) return;
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (session.mode === "move") {
        setWindowGeometry(
          clampRect({
            ...session.origin,
            x: session.origin.x + dx,
            y: session.origin.y + dy,
          }),
        );
        return;
      }
      setWindowGeometry(
        resizeFromCorner(session.origin, dx, dy, session.corner),
      );
    };
    const onPointerUp = () => {
      if (!dragSession.current) return;
      const corner =
        dragSession.current.mode === "resize" ? dragSession.current.corner : null;
      dragSession.current = null;
      document.body.classList.remove("agentguard-dragging");
      if (corner) {
        document.body.classList.remove("agentguard-resizing-" + corner);
      }
      setWindowGeometry((current) => {
        const next = clampRect(current);
        saveGeometry(next);
        return next;
      });
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  const beginWindowDrag = (
    event: React.PointerEvent,
    mode: "move" | "resize",
    corner?: ResizeCorner,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (mode === "move") {
      dragSession.current = {
        mode: "move",
        startX: event.clientX,
        startY: event.clientY,
        origin: windowGeometry,
      };
    } else if (corner) {
      dragSession.current = {
        mode: "resize",
        corner,
        startX: event.clientX,
        startY: event.clientY,
        origin: windowGeometry,
      };
      document.body.classList.add("agentguard-resizing-" + corner);
    }
    document.body.classList.add("agentguard-dragging");
  };

  const closeAgentGuardWindow = () => {
    setAgentGuardOpen(false);
    if (activeRun) setAgentGuardDismissedRunId(activeRun.id);
  };

  const toggleAgentGuardWindow = () => {
    setAgentGuardOpen((open) => {
      const next = !open;
      if (next) setAgentGuardDismissedRunId(null);
      else if (activeRun) setAgentGuardDismissedRunId(activeRun.id);
      return next;
    });
  };

  const handleAgentGuardSettingsSaved = (response: {
    effective: AgentGuardSettingsEffective;
  }) => {
    setBudgetPolicy(response.effective);
    setSystem((current) =>
      current
        ? { ...current, agentGuardTokenBudget: response.effective.tokenBudget }
        : current,
    );
  };
  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const refreshAgentGuard = useCallback(async (runId: string) => {
    const [eventsResult, incidentsResult, recoveriesResult, diagnosesResult] =
      await Promise.all([
        api.events(runId),
        api.incidents(runId),
        api.recoveries(runId),
        api.diagnoses(runId),
      ]);
    if (!mountedRef.current) return;
    setTraceEvents(eventsResult.events);
    setIncidents(incidentsResult.incidents);
    setRecoveries(recoveriesResult.recoveries);
    setDiagnoses(diagnosesResult.diagnoses);
  }, []);

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        await refreshAgentGuard(runId).catch(() => undefined);
        if (!["queued", "running", "recovering", "awaiting_approval"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const injectFailure = async (
    type:
      | "runtime_crash"
      | "tool_timeout"
      | "budget_exceeded"
      | "budget_projected_exceeded",
  ) => {
    if (!activeRun) return;
    setError(null);
    try {
      await api.injectFailure(activeRun.id, type);
      await refreshAgentGuard(activeRun.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const resolveApproval = async (decision: "approve" | "abort") => {
    if (!activeRun) return;
    setError(null);
    try {
      await api.resolveApproval(activeRun.id, decision);
      await refreshAgentGuard(activeRun.id);
      const result = await api.run(activeRun.id);
      setActiveRun(result.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const failingEventId = useMemo(() => {
    const open = incidents.find(
      (item) => item.status === "open" || item.status === "awaiting_approval",
    );
    return open?.eventId ?? null;
  }, [incidents]);

  const latestDiagnosis = useMemo(
    () => diagnoses[0] ?? null,
    [diagnoses],
  );

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="playground-topbar-actions">
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setShowAgentGuardSettings(true)}
                  >
                    Budget settings
                  </button>
                  {activeRun ? (
                    <button
                      type="button"
                      className={
                        "button button-ghost agentguard-toggle" +
                        (agentGuardOpen ? " is-active" : "")
                      }
                      onClick={toggleAgentGuardWindow}
                      aria-pressed={agentGuardOpen}
                    >
                      AgentGuard
                      {incidents.some((item) => item.status === "aborted") ? (
                        <span className="alert-badge">ALERT</span>
                      ) : null}
                      {activeRun.status === "awaiting_approval" ? (
                        <span className="approval-badge">APPROVAL</span>
                      ) : null}
                    </button>
                  ) : null}
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running", "recovering"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>
                        {activeRun.status === "recovering"
                          ? "AgentGuard recovering…"
                          : activeRun.status === "awaiting_approval"
                            ? "Awaiting operator approval…"
                            : "working in the Agent workspace"}
                      </span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      {activeRun.status === "recovering" ? (
                        latestDiagnosis ? (
                          <>
                            <span>{latestDiagnosis.summary}</span>
                            {latestDiagnosis.strategyRationale ? (
                              <em className="diagnosis-inline">
                                {latestDiagnosis.strategyRationale}
                              </em>
                            ) : null}
                          </>
                        ) : (
                          "Middleware is applying a recovery policy…"
                        )
                      ) : activeRun.status === "awaiting_approval" ? (
                        "Approve or abort in the AgentGuard window…"
                      ) : (
                        "Codex is reading, editing, or running commands…"
                      )}
                    </div>
                  </article>
                )}
                {activeRun?.status === "awaiting_approval" && (
                  <article className="run-approval">
                    <strong>Operator approval required</strong>
                    <span>
                      AgentGuard paused recovery. Approve to continue, or abort to stop the
                      run.
                    </span>
                    <div className="run-approval-actions">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => void resolveApproval("approve")}
                      >
                        Approve recovery
                      </button>
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => void resolveApproval("abort")}
                      >
                        Abort
                      </button>
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    (activeRun != null &&
                      ["queued", "running", "recovering", "awaiting_approval"].includes(
                        activeRun.status,
                      ))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["queued", "running", "recovering", "awaiting_approval"].includes(
                          activeRun.status,
                        ))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {activeRun && agentGuardOpen ? (
        <section
          className="agentguard-window"
          role="dialog"
          aria-label="AgentGuard"
          style={{
            left: windowGeometry.x,
            top: windowGeometry.y,
            width: windowGeometry.w,
            height: windowGeometry.h,
          }}
        >
          <div
            className="agentguard-window-header"
            onPointerDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("button, a")) return;
              beginWindowDrag(event, "move");
            }}
          >
            <div>
              <span className="eyebrow">AgentGuard</span>
              <h3>
                Run observability
                {incidents.some((item) => item.status === "aborted") ? (
                  <span className="alert-badge">ALERT</span>
                ) : null}
                {activeRun.status === "awaiting_approval" ? (
                  <span className="approval-badge">APPROVAL</span>
                ) : null}
              </h3>
            </div>
            <div className="agentguard-window-header-actions">
              <div className="agentguard-actions">
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!["running", "recovering"].includes(activeRun.status)}
                  onClick={() => void injectFailure("runtime_crash")}
                >
                  Inject crash
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!["running", "recovering"].includes(activeRun.status)}
                  onClick={() => void injectFailure("tool_timeout")}
                >
                  Inject timeout
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!["running", "recovering"].includes(activeRun.status)}
                  onClick={() => void injectFailure("budget_exceeded")}
                >
                  Inject budget
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!["running", "recovering"].includes(activeRun.status)}
                  onClick={() => void injectFailure("budget_projected_exceeded")}
                >
                  Inject projected
                </button>
                <a
                  className="button button-ghost"
                  href={api.exportEventsUrl(activeRun.id)}
                  download={`run-${activeRun.id}-events.json`}
                >
                  Export JSON
                </a>
              </div>
              <button
                type="button"
                className="button button-ghost agentguard-settings-gear"
                aria-label="AgentGuard policy settings"
                title="AgentGuard policy settings"
                onClick={() => setShowAgentGuardSettings(true)}
              >
                ⚙
              </button>
              <button
                type="button"
                className="agentguard-window-close"
                aria-label="Close AgentGuard"
                onClick={closeAgentGuardWindow}
              >
                ×
              </button>
            </div>
          </div>
          <div className="agentguard-meta">
            <span>Status: {activeRun.status}</span>
            <span>
              Recoveries: {activeRun.recoveryAttemptCount ?? recoveries.length}
            </span>
            <span>
              Budget: {activeRun.tokensUsed ?? 0} / {activeRun.tokenBudget ?? "—"} tokens
              {(() => {
                const used = activeRun.tokensUsed ?? 0;
                const budget = activeRun.tokenBudget ?? 0;
                if (budget <= 0) return null;
                const ratio = used / budget;
                const softRatio = budgetPolicy?.softRatio ?? 0.5;
                const strictRatio = budgetPolicy?.strictRatio ?? 0.85;
                const tier =
                  ratio >= strictRatio ? "strict" : ratio >= softRatio ? "soft" : "normal";
                return tier === "normal" ? null : (
                  <span className="approval-badge"> {tier}</span>
                );
              })()}
            </span>
            {activeRun.usage ? (
              <span>
                Usage: in {activeRun.usage.inputTokens ?? 0} / out{" "}
                {activeRun.usage.outputTokens ?? 0}
              </span>
            ) : (
              <span>Usage: n/a</span>
            )}
          </div>
          {activeRun.status === "awaiting_approval" ? (
            <div className="agentguard-approval-bar">
              <span>Recovery paused — approve to continue or abort the run.</span>
              <div className="agentguard-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void resolveApproval("approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void resolveApproval("abort")}
                >
                  Abort
                </button>
              </div>
            </div>
          ) : null}
          <div className="agentguard-body">
            {latestDiagnosis ? (
              <div className="diagnosis-card">
                <div className="diagnosis-card-head">
                  <strong>Diagnosis</strong>
                  <span className={"diagnosis-status diagnosis-status-" + latestDiagnosis.status}>
                    {latestDiagnosis.status}
                  </span>
                  <span className="diagnosis-confidence">
                    {Math.round(latestDiagnosis.confidence * 100)}% confidence
                  </span>
                </div>
                <p className="diagnosis-summary">{latestDiagnosis.summary}</p>
                <p className="diagnosis-root-cause">{latestDiagnosis.rootCause}</p>
                {latestDiagnosis.evidence.length > 0 ? (
                  <ul className="diagnosis-evidence">
                    {latestDiagnosis.evidence.map((item) => (
                      <li key={item.signal}>
                        <code>{item.signal}</code>
                        <span>
                          {item.value}
                          {item.matched ? " — " + item.matched : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {latestDiagnosis.strategy ? (
                  <p className="diagnosis-strategy">
                    <strong>Action: {latestDiagnosis.strategy}</strong>
                    {latestDiagnosis.strategyRationale ? (
                      <span>{latestDiagnosis.strategyRationale}</span>
                    ) : null}
                  </p>
                ) : null}
                {latestDiagnosis.stateDelta ? (
                  <ul className="diagnosis-delta">
                    <li>
                      Checkpoint <code>{latestDiagnosis.stateDelta.checkpointId}</code> ·{" "}
                      {latestDiagnosis.stateDelta.workspaceFiles} workspace files restored
                    </li>
                    <li>
                      Session{" "}
                      {latestDiagnosis.stateDelta.codexThreadReattached
                        ? "reattached"
                        : "not resumed"}
                      {latestDiagnosis.stateDelta.backoffMs
                        ? " · backoff " + latestDiagnosis.stateDelta.backoffMs + "ms"
                        : ""}
                    </li>
                    <li>
                      Budget {latestDiagnosis.stateDelta.tokensUsed} /{" "}
                      {latestDiagnosis.stateDelta.tokenBudget} tokens
                      {latestDiagnosis.stateDelta.degraded
                        ? " · degraded mode (context compressed)"
                        : ""}
                    </li>
                  </ul>
                ) : null}
                {latestDiagnosis.suggestions.length > 0 ? (
                  <ul className="diagnosis-suggestions">
                    {latestDiagnosis.suggestions.map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                ) : null}
                {latestDiagnosis.recurrenceCount > 0 ? (
                  <p className="diagnosis-recurrence">
                    Signature <code>{latestDiagnosis.signature}</code> · recurring, this run
                    has seen it {latestDiagnosis.recurrenceCount + 1} times
                  </p>
                ) : (
                  <p className="diagnosis-recurrence">
                    Signature <code>{latestDiagnosis.signature}</code> · first occurrence in
                    this run
                  </p>
                )}
              </div>
            ) : null}
            <div className="agentguard-columns">
              <div className="agentguard-column">
                <strong>Timeline</strong>
                <ul className="trace-list">
                  {traceEvents.length === 0 ? (
                    <li className="muted">No events yet</li>
                  ) : (
                    traceEvents.map((event) => (
                      <li
                        key={event.id}
                        className={
                          event.id === failingEventId ? "trace-failing" : undefined
                        }
                        id={
                          event.id === failingEventId
                            ? "agentguard-failing-step"
                            : undefined
                        }
                      >
                        <code>{event.type}</code>
                        <span>
                          {event.status}
                          {event.id === failingEventId ? " · failing step" : ""}
                          {event.parentEventId ? " · child" : ""}
                        </span>
                        {event.error ? <em>{event.error}</em> : null}
                      </li>
                    ))
                  )}
                </ul>
                {failingEventId ? (
                  <button
                    type="button"
                    className="button button-ghost jump-failing"
                    onClick={() => {
                      document
                        .getElementById("agentguard-failing-step")
                        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                    }}
                  >
                    Jump to failing step
                  </button>
                ) : null}
              </div>
              <div className="agentguard-column">
                <strong>Incidents</strong>
                <ul className="trace-list">
                  {incidents.length === 0 ? (
                    <li className="muted">None</li>
                  ) : (
                    incidents.map((incident) => (
                      <li key={incident.id}>
                        <code>{incident.failureType}</code>
                        <span>{incident.status}</span>
                      </li>
                    ))
                  )}
                </ul>
                <strong>Recoveries</strong>
                <ul className="trace-list">
                  {recoveries.length === 0 ? (
                    <li className="muted">None</li>
                  ) : (
                    recoveries.map((attempt) => (
                      <li key={attempt.id}>
                        <code>{attempt.strategy}</code>
                        <span>{attempt.status}</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          </div>
          <div
            className="agentguard-resize-handle agentguard-resize-nw"
            onPointerDown={(event) => beginWindowDrag(event, "resize", "nw")}
            aria-hidden="true"
          />
          <div
            className="agentguard-resize-handle agentguard-resize-ne"
            onPointerDown={(event) => beginWindowDrag(event, "resize", "ne")}
            aria-hidden="true"
          />
          <div
            className="agentguard-resize-handle agentguard-resize-sw"
            onPointerDown={(event) => beginWindowDrag(event, "resize", "sw")}
            aria-hidden="true"
          />
          <div
            className="agentguard-resize-handle agentguard-resize-se"
            onPointerDown={(event) => beginWindowDrag(event, "resize", "se")}
            aria-hidden="true"
          />
        </section>
      ) : null}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      <AgentGuardSettingsModal
        open={showAgentGuardSettings}
        onClose={() => setShowAgentGuardSettings(false)}
        onSaved={handleAgentGuardSettingsSaved}
      />
    </div>
  );
}
