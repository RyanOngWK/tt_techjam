# Technical Requirements Document: AgentGuard

## 1. System Overview and Architectural Thesis

AgentGuard is a deterministic, observable middleware layer around the Volc Agent Launchpad runtime. Telemetry is the feedback loop; failures become incidents; recovery uses policy-driven actions; checkpoints let an Agent resume safely; **BudgetPolicy** steers token cost before and during turns (soft auto) while exact overruns remain HITL.

**Middleware story:** Team-designed reliability middleware (observability + deterministic recovery + proactive budget control), aligned with official Trace/Observability and failure-recovery directions—not a mandatory single track. Optional legacy label: Glass Box + recovery. Product requirements: [AgentGuard PRD](./AgentGuard%20PRD.md).

```mermaid
flowchart LR
  UI["Web UI / Dashboard"] --> API["Fastify /api"]
  API --> AS["AgentService"]
  AS --> TC["Trace Collector"]
  AS --> FD["Failure Detector"]
  AS --> RC["Recovery Controller"]
  AS --> BP["Budget Policy"]
  AS --> CP["Checkpoint Store"]
  AS --> Runner["AgentRunner"]
  TC --> TS["Trace Store / JsonStore"]
  FD --> TS
  RC --> TS
  BP --> TS
  CP --> Disk["Workspace snapshots"]
  Runner --> Runtime["Container / Codex"]
```

## 2. Integration Points and Starter Seams

| Seam | File(s) | AgentGuard change |
| --- | --- | --- |
| Fastify routes | `apps/server/src/app.ts` | Add events, incidents, recoveries, fail-injection under `/api` |
| AgentService | `apps/server/src/agent-service.ts` | Emit/persist events; open incidents; invoke recovery; checkpoints; **pre-turn BudgetPolicy wrap/gate; mid-turn projection cancel** |
| AgentRunner | `apps/server/src/types.ts`, `codex-runner.ts`, `container-codex-runner.ts` | Surface step-level events from Codex JSONL; support cancel/restart for injection and mid-turn budget cancel |
| Types / DB | `apps/server/src/types.ts`, `store.ts` | Extend `Database` with `events`, `incidents`, `recoveryAttempts`, `checkpoints`; budget fields on run |
| Config | `apps/server/src/config.ts`, `.env.example` | `AGENTGUARD_TOKEN_BUDGET` + soft-tier / projection estimate knobs |
| Workspace | `apps/server/src/workspace.ts` | Snapshot / restore helpers for checkpoint refs |
| Web UI | `apps/web/src/App.tsx`, `api.ts` | Timeline, incidents, recoveries, alert badge, budget meter/tier, usage display, inject-failure control |

Reuse existing run creation: `POST /api/agents/:id/messages` → creates `AgentRun`. Do **not** introduce a parallel `POST /runs` root.

## 3. Core Implementation Components

| Component | Module (proposed) | Responsibility |
| --- | --- | --- |
| Event / Trace Collector | `apps/server/src/agentguard/trace-collector.ts` | Map runner/Codex lines → `TraceEvent`; redact secrets |
| Trace Store | persistence via `JsonStore` | Persist events keyed by `run_id` |
| Failure Detector | `apps/server/src/agentguard/failure-detector.ts` | Classify failures; open `Incident` |
| Recovery Controller | `apps/server/src/agentguard/recovery-controller.ts` | Select policy; execute retry / restart_resume / abort / compress_resume; verify |
| **Budget Policy** | `apps/server/src/agentguard/budget-policy.ts` | Tier selection, prompt wrap, pre-turn gate, mid-turn projection, compress text |
| Checkpoint Service | `apps/server/src/agentguard/checkpoint.ts` | Snapshot workspace + `codexThreadId`; restore |
| Redactor | `apps/server/src/agentguard/redact.ts` | Strip keys/tokens from metadata and errors |
| Dashboard | extend `apps/web` | Poll APIs; render timeline / incidents / recoveries / usage / budget |

## 4. Canonical Schemas

### Enums

```text
RunStatus: queued | running | recovering | awaiting_approval | completed | failed | cancelled
IncidentStatus: open | recovering | resolved | aborted
RecoveryStatus: started | succeeded | failed | verified
FailureType: runtime_crash | tool_timeout | transient_tool_error | budget_exceeded
  | budget_projected_exceeded | unknown
RecoveryStrategy: retry | restart_resume | compress_resume | abort
EventType: RUN_STARTED | RUN_COMPLETED | RUN_FAILED | MODEL_CALL | TOOL_CALL
  | CHECKPOINT_CREATED | ERROR | INCIDENT_OPENED | RECOVERY_STARTED
  | RECOVERY_COMPLETED | RECOVERY_FAILED | RECOVERY_VERIFIED | ALERT
  | BUDGET_SOFT_LIMIT | BUDGET_PROJECTED_EXCEED | BUDGET_COMPRESSED
  | BUDGET_EXCEEDED | BUDGET_RAISED
EventStatus: ok | error | running
Severity: low | medium | high
BudgetTier: normal | soft_warn | strict
```

### Entities

**Run** (extends starter `AgentRun`)

| Field | Type | Notes |
| --- | --- | --- |
| id | string | Existing run id; **trace id** for correlation |
| agentId | string | |
| status | RunStatus | Includes `recovering`, `awaiting_approval` |
| sessionId / codexThreadId | string \| null | Align with agent `codexThreadId` |
| recoveryAttemptCount | number | Default 0 |
| tokensUsed | number | Cumulative exact usage from completed turns |
| tokenBudget | number | From `AGENTGUARD_TOKEN_BUDGET`; raised on Approve |
| startedAt / completedAt | string (ISO) | Existing timestamps |
| prompt / output / error / usage | existing | Expose `usage` on dashboard when present |

**TraceEvent**

| Field | Type | Notes |
| --- | --- | --- |
| id | string | **Span id** |
| runId | string | **Trace id** (same as run) |
| parentEventId | string \| null | Parent span for tree/timeline |
| type | EventType | |
| status | EventStatus | |
| timestamp | string (ISO) | |
| durationMs | number \| null | |
| metadata | object (redacted) | |
| error | string \| null (redacted) | |

MVP does not add separate `traceId`/`spanId` columns; document the mapping above in README/design summary.

**Incident**

| Field | Type |
| --- | --- |
| id | string |
| runId | string |
| eventId | string |
| failureType | FailureType |
| severity | Severity |
| status | IncidentStatus |
| createdAt / resolvedAt | string \| null |

**RecoveryAttempt**

| Field | Type |
| --- | --- |
| id | string |
| incidentId | string |
| runId | string |
| strategy | RecoveryStrategy |
| status | RecoveryStatus |
| startedAt / completedAt | string \| null |
| error | string \| null |

**Checkpoint**

| Field | Type |
| --- | --- |
| id | string |
| runId | string |
| agentId | string |
| codexThreadId | string \| null |
| workspaceSnapshotRef | string | Path under data root, e.g. `checkpoints/<runId>/<checkpointId>/` |
| boundary | string | e.g. `after_tool_call` |
| createdAt | string (ISO) |

### JsonStore extension

```text
Database v2:
  agents, messages, runs          # existing
  events: TraceEvent[]
  incidents: Incident[]
  recoveryAttempts: RecoveryAttempt[]
  checkpoints: Checkpoint[]       # metadata only; files on disk
```

## 5. State Machines

### Run

```text
queued -> running -> completed
                 \-> recovering -> running -> completed
                 \-> failed | cancelled
recovering -> failed   # abort or verification failure
```

### Incident

```text
open -> recovering -> resolved   # verified recovery
                  \-> aborted    # policy exhausted or unknown/abort strategy
```

### RecoveryAttempt

```text
started -> succeeded -> verified
        \-> failed
```

`verified` is set only after `RECOVERY_VERIFIED` is emitted (PRD §8).

## 6. Sequence: Failure → Recovery → Verify

```mermaid
sequenceDiagram
  participant Runner
  participant Collector
  participant Detector
  participant Policy
  participant Checkpoint
  participant Store

  Runner->>Collector: step/error events
  Collector->>Store: TraceEvent (redacted)
  Collector->>Detector: ERROR / timeout / crash signal
  Detector->>Store: Incident open
  Detector->>Policy: select strategy
  alt retry
    Policy->>Runner: re-issue step
  else restart_resume
    Policy->>Checkpoint: restore latest
    Checkpoint->>Runner: resume thread + workspace
  else abort
    Policy->>Store: Incident aborted + ALERT
  end
  Runner->>Collector: successful MODEL_CALL or TOOL_CALL
  Collector->>Store: RECOVERY_VERIFIED
  Policy->>Store: attempt verified, incident resolved
```

## 7. Policy Engine Rules

| FailureType | Strategy | Limits |
| --- | --- | --- |
| `tool_timeout` | `retry` | Max 2 retries (3 attempts total); then `abort` + `ALERT` |
| `transient_tool_error` | `retry` | Same as timeout |
| `runtime_crash` | `restart_resume` | Max 1 restart_resume per incident; if no checkpoint → `abort` + `ALERT`; second crash may require HITL |
| `budget_projected_exceeded` | `compress_resume` | Automatic; max 2 auto compresses per run; then escalate to `budget_exceeded` HITL |
| `budget_exceeded` | HITL then continue or `abort` | Approve raises budget (`tokensUsed + AGENTGUARD_TOKEN_BUDGET`); Abort + `ALERT` |
| `unknown` | `abort` | Immediate abort + `ALERT` |
| Policy exhausted | `abort` | `ALERT` badge on run |

Backoff: attempt 1 immediate; attempt 2 after 10ms.  
Verification window: 60s after attempt `succeeded` for restart/retry/compress paths.

Classification is rule-based (exit codes, runner timeout flags, injected fail type, budget projection flags)—never LLM-invented recovery (ADR-001).

## 7a. BudgetPolicy Module

**Module:** `apps/server/src/agentguard/budget-policy.ts` (pure functions; unit-tested).

### Config (env / `loadConfig`)

| Key | Default | Meaning |
| --- | --- | --- |
| `AGENTGUARD_TOKEN_BUDGET` | `50000` | Per-run hard budget; `0` disables all budget controls |
| `AGENTGUARD_BUDGET_SOFT_RATIO` | `0.5` | Soft-warn tier threshold |
| `AGENTGUARD_BUDGET_STRICT_RATIO` | `0.85` | Strict tier; enables mid-turn cancel |
| `AGENTGUARD_BUDGET_EST_MODEL_TOKENS` | `2000` | Heuristic tokens per `MODEL_CALL` span |
| `AGENTGUARD_BUDGET_EST_TOOL_TOKENS` | `1000` | Heuristic tokens per `TOOL_CALL` span |
| `AGENTGUARD_BUDGET_CHARS_PER_TOKEN` | `4` | Stream-byte → token estimate |
| `AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE` | `8000` | Pre-turn projected cost if starting another turn |
| `AGENTGUARD_BUDGET_MAX_COMPRESS_RECOVERIES` | `2` | Auto compress_resume cap per run |

Env keys are **defaults**. Operators may override at runtime via the settings API; overrides persist in `Database.agentGuardSettings` (JsonStore) and merge on read (`effective = { ...envDefaults, ...overrides }`).

### Runtime settings API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/agentguard/settings` | — | `{ defaults, overrides, effective }` |
| PATCH | `/api/agentguard/settings` | sparse partial overrides | same |
| POST | `/api/agentguard/settings/reset` | — | clears overrides → env defaults |

**Precedence:** env < stored overrides. **Reset** sets `agentGuardSettings: null`.

**Apply rules:**

- `tokenBudget` — snapshot on **new run** creation; HITL Approve raise uses effective `tokenBudget` at approve time.
- Ratios, estimate knobs, `maxCompressRecoveries`, `requireApprovalAfterCrashes` — read **live** each turn/recovery via `AgentService.effectiveSettings()`.

**Validation:** same bounds as env zod schema; `strictRatio` must be greater than `softRatio` (effective merge checked on PATCH).

**Module:** `apps/server/src/agentguard/settings.ts`.

### Algorithms

```text
tier(tokensUsed, tokenBudget, softRatio, strictRatio) -> normal | soft_warn | strict
  if tokenBudget <= 0: treat as disabled (caller skips)
  ratio = tokensUsed / tokenBudget
  if ratio >= strictRatio: strict
  else if ratio >= softRatio: soft_warn
  else: normal

projectUsage(tokensUsed, modelCalls, toolCalls, streamBytes, estimates) -> number
  return tokensUsed
    + modelCalls * EST_MODEL
    + toolCalls * EST_TOOL
    + floor(streamBytes / CHARS_PER_TOKEN)

shouldCancelMidTurn(projected, tokenBudget, tier) -> boolean
  // Mid-turn cancel is enabled only in strict tier (≥85%).
  if tokenBudget <= 0: false
  if tier != strict: false
  return projected > tokenBudget

shouldBlockPreTurn(tokensUsed, tokenBudget, nextTurnEstimate) -> boolean
  return tokenBudget > 0 and (tokensUsed + nextTurnEstimate) > tokenBudget

wrapPrompt({ prompt, tokensUsed, tokenBudget, tier, recentEventSummaries }) -> string
  prepend deterministic [AgentGuard budget control] block with remaining tokens,
  tier rules, truncated original goal, last N event summaries, concise/minimal-tools instruction
```

### AgentService wiring

```mermaid
sequenceDiagram
  participant AS as AgentService
  participant BP as BudgetPolicy
  participant Runner as AgentRunner
  participant Store as JsonStore

  AS->>BP: tier + shouldBlockPreTurn
  alt blocked
    AS->>BP: wrapPrompt compress
    AS->>Store: BUDGET_COMPRESSED
    Note over AS: retry once; else escalate HITL
  else ok
    AS->>BP: wrapPrompt by tier
    AS->>Store: BUDGET_SOFT_LIMIT if tier crossed
    AS->>Runner: run(wrappedPrompt)
    loop onEvent spans
      AS->>BP: projectUsage
      alt projected exceed
        AS->>Runner: cancel
        AS->>Store: BUDGET_PROJECTED_EXCEED
        AS->>AS: compress_resume recovery
      end
    end
    Runner-->>AS: turn.completed usage
    AS->>Store: accumulate tokensUsed
    alt exact exceed
      AS->>Store: BUDGET_EXCEEDED + awaiting_approval
    end
  end
```

**Exact post-turn exceed** remains the only automatic path to `awaiting_approval` for budget (plus escalate after compress cap). Soft actions never require Approve.

## 8. Checkpoint Mechanics

**When:** After each successful `MODEL_CALL` or `TOOL_CALL` boundary (and emit `CHECKPOINT_CREATED`).

**What:**

1. Copy agent workspace to `workspaceSnapshotRef` (atomic copy into `checkpoints/<runId>/<checkpointId>/`).
2. Persist current `codexThreadId` on the checkpoint record.
3. Keep last N=5 checkpoints per run; prune older snapshot dirs.

**Restore (`restart_resume` / `compress_resume`):**

1. Load latest valid checkpoint for the run.
2. Replace workspace contents from snapshot.
3. Set agent `codexThreadId` from checkpoint.
4. Re-enter `AgentRunner.run` with resume semantics (existing Codex resume).
5. For `compress_resume` only: replace next prompt with `wrapPrompt` compress variant; emit `BUDGET_COMPRESSED`.

**Invalid checkpoint:** If snapshot incomplete or missing, skip to previous; if none, abort.

## 9. APIs (aligned to `/api`)

| Method and endpoint | Purpose |
| --- | --- |
| `POST /api/agents/:id/messages` | Existing — create run (unchanged) |
| `GET /api/runs/:id` | Existing — run status (`recoveryAttemptCount`, `tokensUsed`, `tokenBudget`, `awaiting_approval`) |
| `GET /api/runs/:id/events` | Trace events for a run (ordered); `?format=download` for evidence export |
| `GET /api/incidents` | List incidents (`?runId=` optional filter) |
| `GET /api/runs/:id/recoveries` | Recovery attempts for a run |
| `GET /api/runs/:id/checkpoints` | Checkpoint metadata for a run (optional helper) |
| `POST /api/runs/:id/fail` | Inject controlled failure for demo/tests |
| `POST /api/runs/:id/approve` | Operator approve / abort while `awaiting_approval` |

### Failure injection

```json
POST /api/runs/:id/fail
{ "type": "runtime_crash" | "tool_timeout" | "budget_exceeded" }
```

Behavior:

- Run must be `running` or `recovering` (budget also accepted while awaiting approval for cancel race).
- Sets an in-memory injection flag; cancels the active runner so `AgentService` classifies the failure.
- `runtime_crash` → restart_resume from latest checkpoint (second crash may require approval).
- `tool_timeout` → retry from latest checkpoint (shared restore path with crash).
- `budget_exceeded` → pause for approve (raise budget + continue) or abort + ALERT.
- Optional demo inject for projected path may cancel the runner and set an in-memory projected flag so AgentService classifies `budget_projected_exceeded` (soft compress) without requiring a long real turn.
- Deterministic for demos; does not rely on flaky external failures.

One-pager: [agentguard-architecture.md](agentguard-architecture.md).

## 10. Secret Redaction

Before persist or API response, redact from `metadata` and `error`:

- Env-style keys: `ARK_API_KEY`, `API_KEY`, `AUTHORIZATION`, `BEARER`, BytePlus-style `AK`/`SK` material
- Patterns: `sk-…`, `Bearer …`, long base64 tokens in headers

Replace with `[REDACTED]`. Unit-test the redactor with fixture strings.

**Surfaces that must stay clean (official acceptance):** source, Git history, logs, traces, screenshots, browser storage, and demo output. Never commit or display Ark model API keys or BytePlus account AK/SK. Never send the Ark key to the browser.

## 11. Architectural Decision Records

- **ADR-001 (Deterministic Recovery Policies):** Predefined strategies only; no LLM-invented recovery.
- **ADR-002 (Middleware Owns Recovery):** Recovery outside the Agent prompt loop.
- **ADR-003 (Event-Based Observability):** Structured `TraceEvent` stream as source of truth.
- **ADR-004 (Checkpointing):** Workspace + `codexThreadId` at successful step boundaries.
- **ADR-005 (Extend starter APIs):** Prefer `/api/runs/:id/...` over a parallel `/runs` API.
- **ADR-006 (Alert = UI only):** MVP alerts are dashboard badges + `ALERT` events.
- **ADR-007 (Trace/span mapping):** `runId` is the trace id; `eventId` is the span id; no duplicate ID fields in MVP.
- **ADR-008 (Team-designed story):** Official examples are optional; AgentGuard combines observability + recovery rather than claiming a mandatory named track.
- **ADR-009 (Proactive Budget in Middleware):** Budget steering lives in `BudgetPolicy` + `AgentService`, not in the Agent prompt loop alone; soft actions are automatic; exact exceed is HITL.
- **ADR-010 (Heuristic Mid-Turn Projection):** Mid-turn cancel uses span counts + stream bytes because Codex only reports exact usage on `turn.completed`; exact accounting remains authoritative for hard HITL.
- **ADR-011 (Deterministic Compress Wrap):** Context compression is a middleware-built prompt prefix; no LLM summarizer and no fresh-thread reset in MVP.

## 12. Dashboard Technical Approach

- Extend `apps/web` playground / run panel; poll `GET /api/runs/:id`, `/events`, `/recoveries`, and `/api/incidents?runId=`.
- Run header shows starter `usage` when non-null and budget meter (`tokensUsed` / `tokenBudget`); soft-tier badge when soft/strict.
- Highlight `BUDGET_*` events in the timeline.
- Poll interval: reuse existing run polling (~1s) while status is `running`, `recovering`, or `awaiting_approval`.
- No SSE required for MVP.

## 13. Persistence and Concurrency

- Single-process `JsonStore` atomic writes; serialize mutations that touch events + incidents + recoveries in one store transaction where possible.
- One active run per agent (existing). Recovery does not start a second run id; it continues the same `runId` in `recovering` → `running`.
- Process death mid-recovery: on startup, in-flight runs → `cancelled` (starter behavior); mark open recovery attempts `failed`. No cross-process auto-resume in MVP.

## 14. Testing Strategy

### Unit

- Failure classification, policy selection, retry limits, state transitions, checkpoint create/restore, redaction.
- **BudgetPolicy:** `tier`, `projectUsage`, `shouldCancelMidTurn`, `shouldBlockPreTurn`, `wrapPrompt` (fixtures for ratios, estimates, disabled budget).

### Integration

- AgentService → collector → detector → recovery → store → runner (with mocked runner).
- Soft path: mid-turn cancel → `BUDGET_PROJECTED_EXCEED` → `BUDGET_COMPRESSED` → continue without approval.
- Hard path: exact exceed → `awaiting_approval` → Approve → `BUDGET_RAISED`.

### E2E

| Case | Expect |
| --- | --- |
| Normal successful run | Events timeline; no incidents |
| Runtime crash → restart/resume | Incident, checkpoint restore, `RECOVERY_VERIFIED`, run completed |
| Timeout → successful retry | `retry` then verified |
| Recovery exhaustion → abort | `ALERT`, incident `aborted`, run `failed` |
| Soft budget compress | Soft/projected events; no HITL; run continues |
| Hard budget exceed | HITL Approve/Abort |

### Named fixtures (automated evidence)

- `fixtures/agentguard/crash-then-recover.jsonl` — golden event sequence
- `fixtures/agentguard/timeout-retry.jsonl`
- `fixtures/agentguard/secrets-redacted.json` — assert no raw key material
- `fixtures/agentguard/budget-soft-compress.jsonl` — soft/projected/compress sequence
- `fixtures/agentguard/budget-hard-hitl.jsonl` — exceed → approval → raised

## 15. One-Page Architecture Diagram (deliverable)

Trust boundary = local container / ECS app process (unchanged from starter). Middleware sits inside the control plane. Diagram must show middleware, data flow, trust boundary, and the instrumentation / recovery point:

```text
[Browser UI] --no secrets--> [Fastify /api]
                               |
         [AgentGuard: Trace | Detect | Recover | Checkpoint | BudgetPolicy]
                               |
                         [AgentService]
                               |
                         [AgentRunner] --> [Runtime container / Codex] --> [Ark]
                               |
                    [JsonStore + workspace + checkpoint dirs]
```

Export this diagram for the submission one-pager (README or `docs/agentguard-architecture.png` when drawn).

## 16. Limitations (repo deliverable)

- Single-node JSON persistence; not multi-tenant or HA.
- No recovery across control-plane process restart.
- Alerts are UI-only.
- Classification covers a fixed failure taxonomy, not arbitrary faults.
- Checkpoints are best-effort file copies, not transactional filesystem snapshots.
- Not a replacement for production APM or distributed tracing.
- Trace/span IDs are mapped from `runId`/`eventId` rather than OpenTelemetry exporters.
- Mid-turn budget projection is heuristic; it can false-positive or false-negative vs true Ark usage.
- Soft compress does not shrink the underlying Codex thread history; it only wraps the next user prompt.

## 17. Setup and Reproducibility

### Baseline first (official §3)

Do not rely on the AgentGuard demo until baseline acceptance passes: create Agent → hello-world CLI task completes → follow-up resumes Codex session → stop/restart preserves workspace.

### README (official §9.3)

Must include:

| Section | Content |
| --- | --- |
| Problem | Opaque Agent failures; observability not wired to recovery; reactive-only budgets |
| Rationale | Deterministic policies + traces + proactive budget beat opaque restarts / LLM self-heal |
| Design summary | Trace / Detect / Recover / Checkpoint / BudgetPolicy; `/api` seams; `runId`/`eventId` correlation |
| Setup | One-command local POC |
| Demo steps | Condensed PRD §15 including post-recovery controllability and budget beat |
| Tests | AgentGuard unit/integration; submission gate |
| Limitations | Copy or link §16 |

```bash
ARK_API_KEY=… ARK_MODEL=… npm run poc
```

Open the UI, run the demo script from the PRD, use Inject failure for the crash path.

### Submission gate

```bash
npm run check
```

Must pass (TypeScript checks, server tests, production builds). AgentGuard tests are included in that suite.
