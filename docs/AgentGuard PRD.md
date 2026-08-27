# Product Requirements Document: AgentGuard

## 1. Executive Summary

**Product Name:** AgentGuard  
**Concept:** AgentGuard is middleware that observes AI Agent execution, detects runtime failures, automatically applies predefined recovery strategies, and verifies whether the Agent successfully recovered. It combines observability, self-healing, and **proactive token-budget control** into a single feedback loop.  
**Hackathon Context:** TikTok TechJam 2026. Build missing middleware on the Volc Agent Launchpad starter without rebuilding the baseline platform. Official directions are examples, not a mandatory checklist—teams may invent or combine capabilities.  
**Middleware story:** **AgentGuard** is team-designed **reliability middleware**: structured observability (aligned with the official Trace / Audit / Observability example) plus deterministic failure recovery and cost/budget governance (aligned with lifecycle / reliability directions). Identity/authorization and threat-sandbox tracks are out of scope. If a README label is needed for the older extension guide, use **Glass Box + recovery**.

## 2. Goals and Success Metrics

| Goal | Success metric (MVP) |
| --- | --- |
| Make a Run diagnosable | Correlated event timeline for every run; show model `usage` when available; secrets redacted from all listed surfaces |
| Detect failures deterministically | Classify at least **runtime crash** and **tool timeout** without an LLM |
| Recover without full restart | Checkpoint + resume restores workspace and Codex thread; run completes after injected crash |
| Prove recovery worked | Emit `RECOVERY_VERIFIED` after a successful post-recovery turn step |
| Prevent runaway token cost | Soft tiers auto-steer (hint / mid-turn cancel / compress); hard exceed still HITL Approve/Abort |
| Demo reliability | 3-minute live demo: success path + injected crash → detect → recover → verify; briefly show budget soft/compress or hard HITL |

## 3. Problem Statement

- AI Agents perform multi-step tasks involving LLM calls, tool calls, filesystem operations, code execution, and external APIs.
- A single failure can terminate the entire run, requiring human investigation and manual restarts.
- Observability is typically treated as a dashboard rather than a sensor for automated recovery.
- Token usage is only known accurately after a Codex turn completes, so a post-turn budget gate alone cannot steer the Agent before cost overruns; runs can burn most of a budget in one long turn.

## 4. Personas

| Persona | Need |
| --- | --- |
| **Judge / reviewer** | See a real Agent run, a correlated trace, an injected failure, and middleware recovery in ≤3 minutes |
| **Operator (team member)** | Inspect run timeline, incidents, recovery history, and alert badges on the dashboard |
| **Agent owner** | Start agents and prompts via the existing playground; middleware stays transparent unless a failure occurs |

## 5. Core Architecture and Components

Four major middleware components operate **outside** the Agent itself:

- **Observability / Trace Layer:** Records structured events (see event catalog below).
- **Failure Detector:** Consumes events and identifies failures deterministically (e.g. runtime crashes, tool timeouts) without LLM classification.
- **Recovery Engine:** Receives an incident and executes a predefined recovery policy, then verifies recovery.
- **Budget Policy:** Pre-turn prevention, heuristic mid-turn projection cancel, and deterministic context compression on soft recovery (see §6a). Hard exact exceed remains HITL.

### Event catalog (canonical)

| Type | Meaning |
| --- | --- |
| `RUN_STARTED` / `RUN_COMPLETED` / `RUN_FAILED` | Run lifecycle |
| `MODEL_CALL` | LLM / model invocation span |
| `TOOL_CALL` | Tool or filesystem / code-execution span |
| `CHECKPOINT_CREATED` | Checkpoint taken at a boundary |
| `ERROR` | Error attached to a span or run |
| `INCIDENT_OPENED` | Failure detector opened an incident |
| `RECOVERY_STARTED` / `RECOVERY_COMPLETED` / `RECOVERY_FAILED` | Recovery attempt lifecycle |
| `RECOVERY_VERIFIED` | Post-recovery success signal (see §8) |
| `ALERT` | Dashboard-visible alert badge (no external channel in MVP) |
| `BUDGET_SOFT_LIMIT` | Soft tier crossed (50% or 85%); auto steering applied |
| `BUDGET_PROJECTED_EXCEED` | Mid-turn heuristic projection exceeded remaining budget; cancel issued |
| `BUDGET_COMPRESSED` | Deterministic prompt wrap applied before resume |
| `BUDGET_EXCEEDED` | Exact post-turn `tokensUsed > tokenBudget` |
| `BUDGET_RAISED` | Operator approved; budget extended |

## 6. Recovery Strategies and Checkpointing

Checkpoints capture **workspace files + `codexThreadId`** so resume continues the Codex session instead of starting from scratch.

| Failure type | MVP? | Predefined strategy |
| --- | --- | --- |
| Runtime crash | **Required** | Restart runtime + resume from latest checkpoint |
| Tool timeout | **Required** | Retry (bounded) |
| Transient tool error | Supported | Retry (bounded) |
| Budget projected exceed | **Required** | Cancel turn → restore checkpoint → compress wrap → resume (**automatic**, no HITL) |
| Budget exceeded (exact) | **Required** | Pause for Approve (raise budget) or Abort + alert |
| Repeated failure (policy exhausted) | Required for E2E | Abort + dashboard alert badge |
| Unknown failure | Supported | Abort + dashboard alert badge |

**Alert (MVP):** UI badge + `ALERT` event on the run/incident only. No webhook, email, or pager integration.

## 6a. Proactive Budget Control

Post-turn exact accounting alone is reactive. AgentGuard adds a **BudgetPolicy** module that steers cost **before** and **during** a Codex turn, while keeping hard overruns under operator control.

### Tier table (usage ratio = `tokensUsed / tokenBudget`)

| Tier | Ratio | Behavior | Operator? |
| --- | --- | --- | --- |
| Normal | `< 50%` | Optional light remaining-budget hint in prompt | No |
| Soft warn | `≥ 50%` and `< 85%` | Concise-mode prompt wrap; emit `BUDGET_SOFT_LIMIT` | No (auto) |
| Strict | `≥ 85%` | Strict concise wrap; enable mid-turn projection cancel; emit `BUDGET_SOFT_LIMIT` (strict) | No (auto) |
| Hard | `tokensUsed > tokenBudget` (exact, post-turn) | Existing HITL: Approve (raise budget) or Abort | **Yes** |

### Pre-turn prevention

Before each `AgentRunner.run`:

1. Compute `remaining = tokenBudget - tokensUsed`.
2. If `tokenBudget <= 0`, skip budget controls (disabled).
3. If a fixed projected next-turn cost exceeds `remaining`, do **not** start the turn: apply compress wrap once and retry; if still blocked, escalate to hard HITL (`budget_exceeded`).
4. Otherwise wrap the prompt with remaining budget and tier instructions (deterministic; no extra LLM call).

### Heuristic mid-turn cancellation

Codex reports exact usage only on `turn.completed`. Mid-turn, BudgetPolicy maintains:

`projected = tokensUsed + (modelCalls × EST_MODEL) + (toolCalls × EST_TOOL) + (streamBytes / BYTES_PER_TOKEN)`

When projection exceeds `tokenBudget` **and** the run is in the **strict** tier (≥85%):

1. Cancel the active Codex process (existing runner cancel).
2. Emit `BUDGET_PROJECTED_EXCEED`.
3. Classify as `budget_projected_exceeded` → soft recovery (checkpoint restore + compress), **not** HITL.
4. Cap automatic compress recoveries per run (default **2**); further projected trips escalate to hard HITL.

### Context compression on recovery

Deterministic prompt wrap (resume **same** `codexThreadId`):

```text
[AgentGuard budget control]
tokensUsed / tokenBudget, remaining, tier rules
Original goal: <truncated user prompt>
Recent steps: <last N timeline event summaries>
Continue with minimal tools and concise output.
```

Emit `BUDGET_COMPRESSED`. No LLM summarizer and no fresh-thread reset in MVP.

### Soft auto / hard HITL

- Soft tiers, mid-turn cancel, and compress resume run **without** operator approval.
- Exact post-turn exceed keeps existing Approve / Abort UX.

## 7. Data Model

- **Run:** `run_id`, `agent_id`, `session_id` (Codex thread), `status`, `started_at`, `completed_at`, `recovery_attempt_count`, `tokens_used`, `token_budget`, `usage` (token/model usage when available)
- **TraceEvent:** `event_id` (acts as **span id**), `run_id` (acts as **trace id**), `parent_event_id`, `type`, `status`, `timestamp`, `duration_ms`, `metadata`, `error` (redacted)
- **Incident:** `incident_id`, `run_id`, `event_id`, `failure_type`, `severity`, `status`, `created_at`, `resolved_at`
- **RecoveryAttempt:** `attempt_id`, `incident_id`, `run_id`, `strategy`, `status`, `started_at`, `completed_at`, `error`
- **Checkpoint:** `checkpoint_id`, `run_id`, `agent_id`, `codex_thread_id`, `workspace_snapshot_ref`, `created_at`, `boundary` (e.g. after successful tool/model step)

**Correlation mapping (MVP):** `run_id` = trace id; `event_id` = span id; `parent_event_id` links child spans. No separate `traceId`/`spanId` fields required.

Canonical field types and enums live in the [TRD](./AgentGuard%20TRD.md).

## 8. Recovery Verification

A recovery is **verified** when, after a successful recovery attempt:

1. The runtime is running again (for restart/resume) or the retried step is re-issued (for retry), and
2. The middleware observes a subsequent successful span (`MODEL_CALL` or `TOOL_CALL` with status `ok`, or an equivalent runner `turn.completed` without error), and
3. It emits a `RECOVERY_VERIFIED` event linked to the `attempt_id` / `incident_id`.

If no successful span appears within the verification window (see NFRs), the attempt is marked `failed` and policy may retry or abort.

## 9. MVP Scope (Must Have)

- Agent execution and run IDs (reuse starter run creation).
- Structured event tracing and failure detection for **runtime crash**, **tool timeout**, **budget exceeded**, and **budget projected exceed**.
- Retry recovery and runtime restart + checkpoint resume (**both** restore latest workspace + `codexThreadId` checkpoint).
- Token/cost budget per run (`AGENTGUARD_TOKEN_BUDGET`) with abort or HITL raise-budget on **exact** exceed.
- **Proactive budget control** via BudgetPolicy: pre-turn gate + tiered prompt wrap, heuristic mid-turn cancel, deterministic compress-on-recovery (soft auto / hard HITL).
- Optional operator approval before a second crash recovery (`AGENTGUARD_REQUIRE_APPROVAL_AFTER_CRASHES`).
- **Global AgentGuard policy UI** — persisted runtime overrides for token budget, soft/strict tiers, compress cap, and estimation knobs (`GET/PATCH /api/agentguard/settings`; env remains default/fallback).
- Checkpoint/resume (workspace + `codexThreadId`).
- Recovery verification (`RECOVERY_VERIFIED`) and redacted trace logging.
- Basic dashboard (timeline with failing-step highlight, incidents, recoveries, budget tier/soft badges, alert/approval badges, usage, JSON export) and controlled failure injection (`crash` / `timeout` / `budget`).
- Automated tests and end-to-end demo capabilities.
- Architecture one-pager: [agentguard-architecture.md](agentguard-architecture.md).

### Out of Scope

- General autonomous code repair.
- Kubernetes orchestration or distributed multi-agent recovery.
- Production-grade distributed tracing or scheduler.
- General-purpose AI diagnosis or self-healing for arbitrary failures.
- External alerting (PagerDuty, Slack, email).
- Full identity/authorization or threat-sandbox middleware (separate official examples).
- Provider-accurate per-span / mid-turn token metering from Codex or Ark.
- LLM-based history summarization or fresh-thread context reset for compression.
- Operator approval at soft (50% / 85%) thresholds.

## 10. Non-Functional Requirements

| NFR | MVP default |
| --- | --- |
| Max retries per incident (timeout / transient) | 2 retries (3 total attempts) |
| Retry backoff | Immediate then 10ms (demo/test snappy; not production backoff) |
| Tool / step timeout threshold | Match runner bound; classify as `tool_timeout` when exceeded |
| Verification window | 60s after recovery attempt completes |
| Checkpoint frequency | After each successful `MODEL_CALL` or `TOOL_CALL` boundary |
| Soft budget thresholds | 50% (warn), 85% (strict / mid-turn cancel) |
| Mid-turn projection estimates | ~2k tokens/model span, ~1k/tool span, ~4 chars/token (env-overridable) |
| Max auto compress recoveries per run | 2; further projected trips → hard HITL |
| Concurrency | One active run per agent (starter invariant) |
| Persistence | Single-process `JsonStore` (`data/launchpad.json` + snapshot files under data root) |
| Secret handling | No Ark API keys, BytePlus AK/SK, passwords, or bearer tokens in source, Git history, logs, traces, screenshots, browser storage, or demo output; redact before persist/display |

## 11. User Stories and Acceptance Criteria

**US-1 Observability**  
As a judge, I can open a run and see a correlated timeline of model/tool steps with status, duration, errors, and model usage when available.  
**AC:** Given a completed run, `GET /api/runs/:id/events` returns ordered events; dashboard renders them; run header shows `usage` when the starter populated it; no raw secrets appear.

**US-2 Crash recovery**  
As an operator, when the runtime crashes mid-run, the system resumes from the latest checkpoint without discarding prior work.  
**AC:** Given an injected runtime crash after a checkpoint, an incident of type `runtime_crash` is opened, strategy `restart_resume` runs, workspace + thread restore, and `RECOVERY_VERIFIED` is emitted before run completes.

**US-3 Timeout retry**  
As an operator, a tool timeout triggers bounded retry then abort.  
**AC:** Given an injected/simulated timeout, first attempts use `retry`; after max retries, incident resolves as aborted with an `ALERT` badge.

**US-4 Failure injection**  
As a demo operator, I can force a controlled failure.  
**AC:** `POST /api/runs/:id/fail` with `{ "type": "runtime_crash" | "tool_timeout" }` causes the detector to open the matching incident during the active run.

**US-5 Dashboard**  
As a judge, in one view I see run status, timeline, open incidents, recovery history, alert badges, and available model usage.  
**AC:** Dashboard shows those signals for the demo run without leaving the AgentGuard UI surface.

**US-6 Pre-turn budget prevention**  
As an operator, when remaining budget is low, the next turn is steered or blocked before Codex starts.  
**AC:** Given `tokensUsed` near `tokenBudget`, the prompt includes a budget wrap (and/or turn is blocked then compressed once); timeline shows `BUDGET_SOFT_LIMIT` and/or `BUDGET_COMPRESSED` without requiring Approve.

**US-7 Mid-turn projected cancel**  
As an operator, when mid-turn projection exceeds the budget, AgentGuard cancels Codex and resumes with a compressed prompt automatically.  
**AC:** Given a mocked/injected projection exceed (or enough mid-turn spans), runner is cancelled, `BUDGET_PROJECTED_EXCEED` + `BUDGET_COMPRESSED` appear, run continues without `awaiting_approval` unless auto-compress budget is exhausted.

**US-8 Hard budget HITL unchanged**  
As an operator, exact post-turn exceed still pauses for Approve (raise) or Abort.  
**AC:** Given `tokensUsed > tokenBudget` after `turn.completed`, run enters `awaiting_approval`; Approve emits `BUDGET_RAISED` and continues; Abort fails the run with alert.

## 12. Edge Cases

| Case | Expected behavior |
| --- | --- |
| Crash with no checkpoint yet | Abort + alert; do not invent empty resume |
| Crash mid-checkpoint write | Treat checkpoint as invalid; fall back to previous checkpoint or abort |
| Retry while prior tool still running | Cancel/ignore stale tool result; only one attempt in flight |
| Server restart mid-recovery | Starter cancels in-flight runs; mark recovery `failed`, run `cancelled`; no auto-resume across process death (MVP limitation) |
| Unknown failure after partial resume | Open `unknown` incident → abort + alert |
| Concurrent prompt while recovering | Rejected by one-active-run rule |
| `AGENTGUARD_TOKEN_BUDGET=0` | Disable all budget enforcement and soft steering |
| Projection false positive | Soft cancel + compress still safe; run may continue; exact accounting remains source of truth for HITL |
| Auto-compress limit exhausted | Escalate projected exceed to hard HITL (`budget_exceeded`) |
| Soft wrap with empty timeline | Compress using original goal only; still emit `BUDGET_COMPRESSED` |

## 13. Dashboard UX (MVP)

Extend the existing web app (not a separate product). Required views for the demo run:

1. **Run header** — status, agent, timestamps, recovery attempt count, alert badge if any, **budget meter** (`tokensUsed` / `tokenBudget`), soft-tier badge when applicable, **model usage when available**.
2. **Trace timeline** — ordered events (type, status, duration, error snippet); treat `run_id` as trace and `event_id` as span; highlight budget soft/projected/compress/exceed events.
3. **Incidents panel** — failure type, severity, status, linked event.
4. **Recovery history** — strategy, status, timestamps per attempt.
5. **Inject failure** control — demo-only action wired to `POST /api/runs/:id/fail`.
6. **Budget settings** — global AgentGuard policy modal (playground **Budget settings** + gear in floating window); changes persist in JsonStore without redeploy.

Polling (existing pattern) is sufficient; SSE is optional.

## 14. Constraints and Assumptions

- Build on Volc Agent Launchpad: Fastify API, `AgentService`, `AgentRunner`, JSON store, local containers (Docker/Colima/Podman).
- Local POC is the default judging path; ECS optional and does not affect score.
- Do not rebuild Agent CRUD, playground chat, or runtime from scratch; preserve baseline lifecycle.
- Ark API key never sent to the browser; never commit Ark keys or BytePlus AK/SK.
- Pass starter baseline acceptance (TechJam §3) before relying on the AgentGuard demo.
- README must state the middleware problem, rationale, design summary, demo steps, and limitations (official §9.3).

## 15. Live Demo Scenario (3 Minutes)

1. **Create or select an Agent** from the frontend and show its lifecycle state (ready/busy).
2. **Invoke via Playground** with a real task (e.g. create a project, install dependencies, run tests).
3. **Show normal execution:** Display traces for model calls, file/tool actions, checkpoints, and usage when present.
4. **Inject failure:** Trigger a controlled runtime crash during the test phase.
5. **Detection:** Middleware flags an incident identifying a runtime crash and selects restart + resume.
6. **Recovery and verification:** System restores the checkpoint (workspace + thread), resumes, and the timeline shows `RECOVERY_STARTED` → `RECOVERY_COMPLETED` → `RECOVERY_VERIFIED`; run completes.
7. **Budget control (brief):** Show budget meter; trigger soft path (low budget / inject projected path) so timeline shows `BUDGET_SOFT_LIMIT` and/or `BUDGET_COMPRESSED`, **or** inject exact `budget_exceeded` → Approve/Abort HITL.
8. **Platform still controllable:** Show the Agent remains understandable afterward (e.g. stop/start, or send a follow-up message that continues the session / workspace).

Also show (briefly) a clean successful path or pre-injection success spans so judges see the normal case.

## 16. TechJam Deliverables Checklist

Aligned with official TechJam_Info.md §9–§10:

- [ ] Starter **baseline acceptance** passes (hello-world CLI task, multi-turn resume, workspace survives restart) before the AgentGuard demo
- [ ] **README** includes: setup, middleware problem and rationale, design summary, automated tests pointer, demo steps, limitations, no secrets
- [ ] README names the middleware story: **AgentGuard** (observability + deterministic recovery); optional legacy label **Glass Box + recovery**
- [ ] Three-minute live demo (normal case + failure/recovery + post-recovery controllability)
- [ ] One-page architecture diagram (middleware, data flow, trust boundary, recovery/instrumentation point) — see TRD
- [ ] Middleware in backend/runtime path (not UI-only)
- [ ] Automated evidence for classification / policy decision
- [ ] No secrets in source, **Git history**, logs, traces, screenshots, **browser storage**, or demo output (including Ark keys and AK/SK)
- [ ] Reviewer can clone, start with documented command (`npm run poc`), and create/test an Agent from the frontend
- [ ] **`npm run check` passes**

### README outline (required sections)

1. **Problem** — why Agent runs fail opaquely today  
2. **Rationale** — why observability + deterministic recovery (not LLM self-heal)  
3. **Design summary** — Trace / Detect / Recover / Checkpoint / BudgetPolicy; seams into `AgentService` / `AgentRunner`  
4. **Setup** — `ARK_API_KEY=… ARK_MODEL=… npm run poc`  
5. **Demo steps** — PRD §15 condensed  
6. **Tests** — how to run AgentGuard tests; note `npm run check`  
7. **Limitations** — link or copy TRD §16  

## 17. Resolved Decisions

| Decision | Choice |
| --- | --- |
| Official framing | Team-designed reliability middleware (observability + recovery + budget); not a mandatory single “track” |
| Legacy label | Optional “Glass Box + recovery” if needed for extension-guide wording |
| API surface | Extend existing `/api/*` (no parallel `/runs` root) |
| Checkpoint contents | Workspace snapshot + `codexThreadId` |
| MVP failure set | Crash + timeout required; full policy table supported |
| Alert | Dashboard badge + `ALERT` event only |
| Recovery verification | Explicit `RECOVERY_VERIFIED` event after successful post-recovery span |
| Trace / span IDs | `run_id` = trace id; `event_id` = span id |
| Model usage | Display starter `usage` on run header when available |
| Submission gate | `npm run check` + baseline acceptance |
| Proactive budget docs | Extend existing AgentGuard PRD/TRD (Approach A: BudgetPolicy module) |
| Soft vs hard HITL | Soft tiers + mid-turn cancel + compress are automatic; exact exceed stays Approve/Abort |
| Mid-turn signal | Span count + stream-byte volume heuristic (not exact provider tokens) |
| Context compression | Deterministic prompt wrap; resume same Codex thread; no LLM summarizer |
