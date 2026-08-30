# Product Requirements Document: AgentGuard

## 1. Executive Summary

**Product Name:** AgentGuard  
**Track:** **Glass Box — trace and audit.**  
**Concept:** AgentGuard makes an Agent Run diagnosable by representing it as a **span tree** rather than a log stream. Every step carries a category, an actor, a duration, a status, and a parent, and secrets are redacted before storage or display. Failure detection, deterministic recovery, and token-budget control are built **on top of** that trace and exist to prove the trace is good enough to act on.  
**Hackathon Context:** TikTok TechJam 2026. Build missing middleware on the Volc Agent Launchpad starter without rebuilding the baseline platform.

**Positioning:** The trace is the product. Recovery, diagnosis, and budget steering are **consumers** of the trace, not parallel features. The distinguishing claim is a closed loop: a failing span contains its own diagnosis, recovery, checkpoint restore, and verification as nested children, so a reviewer can see detection and repair in one tree instead of correlating separate panels. The official brief states that a polished UI does not count as middleware; this design answers that by making every visible element a projection of backend span data that also drives control decisions.

Identity/authorization and threat-sandbox directions are out of scope.

## 2. Goals and Success Metrics

| Goal | Success metric (MVP) |
| --- | --- |
| Represent a Run as a span tree | Every span has non-null `category`, `actor`, `attemptIndex`, and a parent chain that is acyclic and roots at the run span |
| Record what the brief asks for | Every span carries start time, duration (with measurement source), status, and error detail; token usage attributed per turn |
| Never fabricate telemetry | No span carries `metadata.synthesized`; coverage guarantees come from spans the middleware genuinely owns |
| Locate the failing step | First error span is reachable in one click; works on organic in-turn failures, not only injected ones |
| Redact secrets | No value from a secret-shaped env key appears in any serialized trace, asserted by test |
| Make the trace queryable | Filter spans by category, actor, and status; export evidence as JSON; list all runs with summary counts |
| Prove the trace is actionable | Detection, diagnosis, recovery, and verification appear as **nested children of the failing span** |
| Drive live control from spans | Mid-turn budget cancellation fires from accumulated span data on a first attempt, without injection |
| Demo reliability | 3-minute live demo: success path → real container kill → error span → nested diagnosis/recovery/verification → export |

## 3. Problem Statement

- AI Agents perform multi-step tasks spanning model calls, tool calls, filesystem operations, code execution, and external APIs. The platform records these as **unrelated log lines**, so a Run cannot be reconstructed as a causal structure.
- Without duration, parentage, category, or actor on each step, an operator cannot answer basic forensic questions: which step was slow, what caused the retry, who authorized the continuation, whether a human or the middleware acted.
- **Locating the failing step is manual.** Nothing distinguishes a tool call that returned exit code 1 from one that succeeded, so failures are only visible once they terminate the run.
- Observability is typically treated as a dashboard rather than a **sensor** — telemetry is rendered for humans but never consumed by automated control.
- Payloads and errors carry credential material, so naive tracing creates a secret-leak surface across storage, display, export, and screenshots.
- Token usage is only known accurately after a Codex turn completes, so a post-turn budget gate cannot steer the Agent before cost overruns; runs can burn most of a budget in one long turn.

The through-line: **a Run is a tree, but the platform stores it as a list.** Every downstream problem — unlocatable failures, unattributable decisions, unsteerable cost — follows from that missing structure.

## 4. Personas

| Persona | Need |
| --- | --- |
| **Judge / reviewer** | See a real Agent run, a correlated trace, an injected failure, and middleware recovery in ≤3 minutes |
| **Operator (team member)** | Inspect run timeline, incidents, recovery history, and alert badges on the dashboard |
| **Agent owner** | Start agents and prompts via the existing playground; middleware stays transparent unless a failure occurs |

## 5. Core Architecture and Components

Five major middleware components operate **outside** the Agent itself:

- **Span Collector:** Owns the span lifecycle (`startSpan` / `endSpan` / point-in-time events), assigns category, actor, parent, and attempt index, and redacts before persistence.
- **Runner Instrumentation:** Extracts structured, redacted attributes from Codex JSONL items (command, exit code, changed paths, tool name) and derives real per-span status.
- **Failure Detector:** Consumes spans and identifies failures deterministically (runtime crashes, tool timeouts) without LLM classification.
- **Recovery Engine:** Receives an incident and executes a predefined recovery policy, then verifies recovery. Its spans nest under the failing span.
- **Budget Policy:** Pre-turn prevention, mid-turn projection cancel driven by accumulated span data, and deterministic context compression (see §6a). Hard exact exceed remains HITL.

### Span dimensions (canonical)

Every span carries a **category** and an **actor**, which is what makes the trace
queryable rather than merely readable.

| `category` | Covers |
| --- | --- |
| `orchestration` | `RUN_STARTED`, `TURN`, `RUN_COMPLETED`, `RUN_FAILED` |
| `model_call` | LLM / model invocation |
| `tool_call` | Tool, filesystem, or code execution |
| `checkpoint` | Checkpoint create and restore |
| `policy_decision` | Incident opened, diagnosis issued, budget decision |
| `human_approval` | Approval requested, granted, denied |
| `recovery` | Recovery attempt lifecycle and verification |

| `actor` | Meaning |
| --- | --- |
| `human` | Operator initiated or decided |
| `agent` | The Agent performed the step |
| `middleware` | AgentGuard acted |

### Event catalog (canonical)

| Type | Category | Actor | Meaning |
| --- | --- | --- | --- |
| `RUN_STARTED` | orchestration | human | Run lifecycle start |
| `TURN` | orchestration | middleware | **New.** One runner attempt; measured duration, per-turn usage, attempt index |
| `RUN_COMPLETED` / `RUN_FAILED` | orchestration | middleware | Run lifecycle end |
| `MODEL_CALL` | model_call | agent | LLM / model invocation span |
| `TOOL_CALL` | tool_call | agent | Tool or filesystem / code-execution span |
| `CHECKPOINT_CREATED` / `CHECKPOINT_RESTORED` | checkpoint | middleware | Checkpoint taken or restored at a boundary |
| `ERROR` | tool_call | agent | Error attached to a span or run |
| `INCIDENT_OPENED` | policy_decision | middleware | Failure detector opened an incident |
| `DIAGNOSIS_ISSUED` | policy_decision | middleware | Deterministic diagnosis with evidence, confidence, signature |
| `DIAGNOSIS_VERDICT` | policy_decision | middleware | Diagnosis resolved as verified or aborted |
| `RECOVERY_STARTED` / `RECOVERY_COMPLETED` / `RECOVERY_FAILED` | recovery | middleware | Recovery attempt lifecycle |
| `RECOVERY_VERIFIED` | recovery | middleware | Post-recovery success signal (see §8) |
| `APPROVAL_REQUESTED` | human_approval | middleware | HITL gate opened |
| `APPROVAL_GRANTED` / `APPROVAL_DENIED` | human_approval | human | Operator decision |
| `ALERT` | policy_decision | middleware | Dashboard-visible alert badge (no external channel in MVP) |
| `BUDGET_SOFT_LIMIT` | policy_decision | middleware | Soft tier crossed (50% or 85%); auto steering applied |
| `BUDGET_PROJECTED_EXCEED` | policy_decision | middleware | Mid-turn projection exceeded budget; cancel issued |
| `BUDGET_COMPRESSED` | policy_decision | middleware | Deterministic prompt wrap applied before resume |
| `BUDGET_EXCEEDED` | policy_decision | middleware | Exact post-turn `tokensUsed > tokenBudget` |
| `BUDGET_RAISED` | policy_decision | human | Operator approved; budget extended |

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
- **TraceEvent (span):** `event_id` (acts as **span id**), `run_id` (acts as **trace id**), `parent_event_id`, `type`, `category`, `actor`, `status`, `timestamp` (start), `ended_at`, `duration_ms`, `duration_source`, `attempt_index`, `metadata`, `error` (redacted)
- **Incident:** `incident_id`, `run_id`, `event_id`, `failure_type`, `severity`, `status`, `created_at`, `resolved_at`
- **RecoveryAttempt:** `attempt_id`, `incident_id`, `run_id`, `strategy`, `status`, `started_at`, `completed_at`, `error`
- **Checkpoint:** `checkpoint_id`, `run_id`, `agent_id`, `codex_thread_id`, `workspace_snapshot_ref`, `created_at`, `boundary` (e.g. after successful tool/model step)

**Correlation mapping (MVP):** `run_id` = trace id; `event_id` = span id; `parent_event_id` links child spans. No separate `traceId`/`spanId` fields required.

**Duration semantics.** Codex emits `item.completed` but no `item.started`, so JSONL-derived spans have no observable start. `duration_source` records how a duration was obtained:

| `duration_source` | Applies to | Meaning |
| --- | --- | --- |
| `measured` | `TURN`, recovery, checkpoint spans | Middleware controls both ends; wall-clock timing |
| `inter_item_delta` | model / tool spans from JSONL | Interval since the previously observed item |
| `null` | point-in-time events | Instantaneous by nature; `duration_ms` is legitimately null |

The UI renders `inter_item_delta` durations with a `~` prefix. A qualified number is preferred over a null or a falsely precise one.

**Attempt attribution.** `attempt_index` records which recovery attempt produced a span, satisfying the official brief's "retry or cancellation relationships" requirement: a reviewer can see exactly which work was redone after recovery.

Canonical field types and enums live in the [TRD](./AgentGuard%20TRD.md).

## 8. Recovery Verification

A recovery is **verified** when, after a successful recovery attempt:

1. The runtime is running again (for restart/resume) or the retried step is re-issued (for retry), and
2. The middleware observes a subsequent successful span (`MODEL_CALL` or `TOOL_CALL` with status `ok`, or an equivalent runner `turn.completed` without error), and
3. It emits a `RECOVERY_VERIFIED` event linked to the `attempt_id` / `incident_id`.

If no successful span appears within the verification window (see NFRs), the attempt is marked `failed` and policy may retry or abort.

## 9. MVP Scope (Must Have)

- Agent execution and run IDs (reuse starter run creation).
- **Span model** — every span carries category, actor, parent, attempt index, start time, end time, duration, and duration source. No synthetic spans.
- **Runner instrumentation** — redacted structured attributes extracted per Codex item type (command, exit code, changed paths, tool name) with real per-span status derived from exit codes.
- **Trace tree UI** — run list tab, nested tree, expandable spans, category/actor/status filters, one-click jump to the first error span.
- **Queryable trace API** — filter by category, actor, status, and time; `tree=true` for nested output; JSON evidence export.
- **Real failure injection** — `runtime_crash` kills the runtime container so classification consumes a genuine exit code.
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
- Hash-chained tamper-evident audit log and signed exports (strong for audit, but serve no Glass Box demo beat).
- OpenTelemetry / OTLP exporters (production distributed tracing is out of scope; `runId`/`eventId` mapping is the MVP contract).
- LLM-based trace summarization (conflicts with ADR-001 determinism).
- Trace search, virtualization, or retention policies in the tree UI.
- Cross-process trace recovery after control-plane restart.

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
As a judge, I can open a run and see a correlated **tree** of model/tool steps with status, duration, errors, and model usage.  
**AC:** Given a completed run, `GET /api/runs/:id/events?tree=true` returns spans nested by `parentEventId`; every span has non-null `category`, `actor`, and `attemptIndex`; the parent chain is acyclic and roots at the run span; the dashboard renders the tree with durations; per-turn usage appears on `TURN` spans; no raw secrets appear.

**US-1a Failing step in an organic failure**  
As a judge, I can identify the failing step of a run that failed on its own, without any injected failure.  
**AC:** Given a Codex `command_execution` item with a non-zero exit code, the corresponding span has `status: "error"` and carries the redacted command and exit code; the UI's jump control targets it.

**US-1b Run list**  
As an operator, I can see all runs across all agents and open any one for forensic analysis.  
**AC:** `GET /api/runs` returns runs newest-first with span count, error count, duration, and tokens; selecting one loads its trace in the floating window.

**US-1c Filtering**  
As an operator, I can narrow a large trace to what matters.  
**AC:** `GET /api/runs/:id/events` accepts `category`, `actor`, `status`, and `since`; the UI exposes errors-only, category, and actor filter chips.

**US-1d No fabricated telemetry**  
As a judge, I can trust that every span reflects something that actually happened.  
**AC:** No span in any run carries `metadata.synthesized`; asserted by an automated test. Coverage is guaranteed by the `TURN` span, which the middleware genuinely measures.

**US-1e Actor attribution**  
As an auditor, I can tell whether a human, the Agent, or the middleware performed each step.  
**AC:** Every span has an `actor` of `human`, `agent`, or `middleware`; approval spans attribute the decision to `human`; recovery spans attribute to `middleware`.

**US-1f Closed loop visible in one tree**  
As a judge, I can see detection, diagnosis, recovery, and verification without leaving the trace view.  
**AC:** Given a failed step, `INCIDENT_OPENED`, `DIAGNOSIS_ISSUED`, and `RECOVERY_STARTED` are children of the failing span, and `RECOVERY_VERIFIED` appears under the subsequent successful turn.

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

Extend the existing web app (not a separate product). The **floating, draggable, resizable window is retained deliberately** — the trace detail view lives inside it rather than becoming a separate page, preserving the "middleware, not a second product" property.

1. **Run list tab** — all runs across all agents, newest first: status, duration, span count, error count, tokens. Selecting a run loads its trace.
2. **Run header** — status, agent, timestamps, recovery attempt count, alert badge if any, **budget meter** (`tokensUsed` / `tokenBudget`), soft-tier badge when applicable, **model usage**.
3. **Trace tree** — spans nested by `parentEventId` with expand/collapse. Each row shows category, actor badge, type, status, and duration (`~` prefix when `duration_source` is `inter_item_delta`). Budget and policy spans are highlighted.
4. **Expandable span detail** — clicking a span reveals its full redacted metadata (command, exit code, changed paths, tool name, usage).
5. **Filter chips** — errors only, by category, by actor. **Filtering never flattens the tree:** non-matching ancestors of a match are retained as dimmed, non-interactive scaffolding so a matching span keeps its position in the run. Branches containing no match are removed entirely.
6. **Jump to failing step** — targets the first error span, so it works on organic failures that never became incidents.
7. **Incidents and recovery** — retained, but the primary presentation is nesting under the failing span in the tree.
8. **Inject failure** control — demo action wired to `POST /api/runs/:id/fail`; `runtime_crash` performs a real container kill.
9. **Budget settings** — global AgentGuard policy modal (playground **Budget settings** + gear in floating window); changes persist in JsonStore without redeploy.

Polling (existing pattern) is sufficient; SSE is optional.

## 14. Constraints and Assumptions

- Build on Volc Agent Launchpad: Fastify API, `AgentService`, `AgentRunner`, JSON store, local containers (Docker/Colima/Podman).
- Local POC is the default judging path; ECS optional and does not affect score.
- Do not rebuild Agent CRUD, playground chat, or runtime from scratch; preserve baseline lifecycle.
- Ark API key never sent to the browser; never commit Ark keys or BytePlus AK/SK.
- Pass starter baseline acceptance (TechJam §3) before relying on the AgentGuard demo.
- README must state the middleware problem, rationale, design summary, demo steps, and limitations (official §9.3).

## 15. Live Demo Scenario (3 Minutes)

The demo is structured around the **trace**, not around recovery. Recovery appears as evidence that the trace is actionable.

1. **Create or select an Agent** from the frontend and show its lifecycle state (ready/busy).
2. **Invoke via Playground** with a real task (e.g. create a project, install dependencies, run tests).
3. **Show the span tree:** `TURN` spans with measured durations, nested model and tool spans with commands and exit codes, checkpoints, per-turn token usage. Expand a tool span to show redacted attributes. Apply a category filter and an errors-only filter.
4. **Inject a real failure:** Kill the runtime container mid-run. Codex exits non-zero and the tool span turns red on its own — no synthetic event.
5. **Detection in the tree:** `INCIDENT_OPENED` and `DIAGNOSIS_ISSUED` appear as **children of the failing span**, with evidence, confidence, and the exit-code signature.
6. **Recovery and verification:** `RECOVERY_STARTED` → `CHECKPOINT_RESTORED` nest under the same failing span; the next `TURN` contains `RECOVERY_VERIFIED`; the run completes. Point out `attemptIndex` distinguishing redone work.
7. **Trace drives control (brief):** Show the budget meter and the mid-turn `BUDGET_PROJECTED_EXCEED` decision made from accumulated span data, **or** inject exact `budget_exceeded` → Approve/Abort HITL with the approval attributed to actor `human`.
8. **Audit and export:** Open the run list to show every run across agents; export the trace as JSON and note that no secret material appears.
9. **Platform still controllable:** Send a follow-up message that continues the session and workspace.

Show the clean successful path first so judges see the normal case before the failure.

## 16. TechJam Deliverables Checklist

Aligned with official TechJam_Info.md §9–§10:

- [ ] Starter **baseline acceptance** passes (hello-world CLI task, multi-turn resume, workspace survives restart) before the AgentGuard demo
- [ ] **README** includes: setup, middleware problem and rationale, design summary, automated tests pointer, demo steps, limitations, no secrets
- [ ] README names **one** selected track: **Glass Box — trace and audit**

### Glass Box track acceptance (extension guide)

- [ ] Correlated Run and step events shown in a **tree**
- [ ] Spans include **status, duration, errors, and model usage**
- [ ] Secrets **redacted**, asserted by an automated env-scan test
- [ ] One **successful** task demonstrated end to end
- [ ] The **failing step identified** in one failed task, including an organic (non-injected) failure
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
| Official framing | **Glass Box — trace and audit.** The trace is the product; recovery, diagnosis, and budget are consumers that prove it is actionable |
| Span dimensions | Every span carries `category` and `actor`; both are required, non-null |
| Duration for JSONL spans | Codex has no `item.started`, so use inter-item deltas and record `duration_source` rather than emitting null or false precision |
| Synthetic spans | Removed. Per-turn coverage comes from the `TURN` span the middleware genuinely measures |
| Trace UI location | Stays inside the existing floating window; run list becomes a tab. No separate product page |
| Run list scope | Global across all agents, newest first |
| Failure injection | `runtime_crash` performs a real container kill so classification consumes a genuine exit code |
| Audit chain | Hash-chaining and signed exports cut — they serve no Glass Box demo beat |
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
