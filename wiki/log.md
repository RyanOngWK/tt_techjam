# Wiki Log

## [2026-08-28] ingest | Glass Box span model

Repositioned AgentGuard onto the Glass Box track. `TraceEvent` became a span
carrying `category`, `actor`, `parentEventId`, `attemptIndex`, `endedAt`,
`durationMs`, and `durationSource`. Added `span-taxonomy.ts` and
`span-tree.ts`. Replaced the synthetic `MODEL_CALL` fallback with a measured
`TURN` span. Runner now derives span status from Codex exit codes. Fixed the
mid-turn budget tier defect that made projected cancellation unreachable on a
first attempt. Added `GET /api/runs` and span query filters. README and the
architecture one-pager now name the track, copy TRD limitations (inter-item
deltas, weak byte projection, real container kill for `runtime_crash`), and
reference `docs/assets/agentguard-architecture.png`.

Sources: [PRD](../docs/AgentGuard%20PRD.md), [TRD](../docs/AgentGuard%20TRD.md),
[design](../docs/superpowers/specs/2026-08-27-glass-box-span-model-design.md).

## [2026-08-28] ingest | Span filter chips and expandable detail

Trace timeline chips (Errors only, category, actor) build `activeFilter` and
pass it to client `buildSpanTree`; inactive groups omit their keys so empty
arrays are never sent. Clicking a span type expands a detail row. Scaffold
ancestors stay dimmed with a clickable expand toggle. Updated
[agentguard.md](agentguard.md), [architecture.md](architecture.md), and
[sources.md](sources.md).

## [2026-08-28] ingest | Nested span tree in Trace tab

The Trace tab timeline now renders a nested `SpanRow` tree (`buildSpanTree`
with no filter yet) instead of a flat event list. Rows show indent,
expand/collapse (default open), actor badges, durations, and
`id="agentguard-failing-step"` on the first error span. Styles use existing
light-theme tokens (`var(--red)`, `var(--muted)`, `#f8e4e4`, `#e3f2ea`).
Updated [agentguard.md](agentguard.md) and [architecture.md](architecture.md).

## [2026-08-28] ingest | Drop stale AgentGuard refresh after run-list selection

`refreshAgentGuard` now ignores in-flight results when `activeRunIdRef` no
longer matches the requested run, so a previous run's Promise.all cannot
overwrite the timeline after the user picks another row. Updated
[agentguard.md](agentguard.md).

## [2026-08-28] ingest | AgentGuard run list tab

The floating AgentGuard window now has Trace and Runs tabs. Opening Runs calls
`api.listRuns()`; clicking a row loads that run's trace (and polls if still
active) and selects its playground agent without clobbering the chosen run.
Updated [agentguard.md](agentguard.md) and [architecture.md](architecture.md).

## [2026-08-28] ingest | Web span types and API client

Web `TraceEvent` now includes category, actor, endedAt, durationSource, and
attemptIndex, plus `SpanNode` and `RunListItem`. The client duplicates
`buildSpanTree` (O(n) cycle guard, intentional) and adds `api.listRuns` /
`api.spanTree`. Updated [architecture.md](architecture.md),
[api-and-data.md](api-and-data.md), [agentguard.md](agentguard.md), and
[sources.md](sources.md).

## [2026-08-28] ingest | Redaction evidence and fixture shapes

`redaction-evidence.test.ts` serializes a completed run and asserts a configured
`ARK_API_KEY` never appears in any span (command, output preview, or error).
`crash-then-recover.json` now includes `TURN` after `RUN_STARTED` and a `shape`
block (`rootType`, `requiredCategories`). Production redactor unchanged — the
evidence test passed on first run. Updated [agentguard.md](agentguard.md) and
[sources.md](sources.md).

## [2026-08-28] ingest | Span tree 404 for unknown runs

`getSpanTree` now calls `getRun` first, so `GET /api/runs/:id/events?tree=true`
returns 404 for a missing run, matching the flat events path. Updated
[api-and-data.md](api-and-data.md) and [agentguard.md](agentguard.md).

## [2026-08-28] ingest | Run list and span query API

`GET /api/runs` returns `{ runs }` newest-first with per-run summary counts.
`GET /api/runs/:id/events` accepts `category`, `actor`, `status`, `since`, and
`tree=true` while keeping `{ events }` and `format=json|download`. Updated
[api-and-data.md](api-and-data.md) and [agentguard.md](agentguard.md).

## [2026-08-28] ingest | Real container-kill crash injection

`injectFailure(..., "runtime_crash")` calls optional `AgentRunner.kill` when
present. `ContainerCodexRunner.kill` force-removes the container without
setting `cancelled`, so the child exits non-zero. Runners without `kill` still
use cancel plus the injection flag. Updated [agentguard.md](agentguard.md) and
[runtime-and-deployment.md](runtime-and-deployment.md).

## [2026-08-28] ingest | Mid-turn budget tier from projected usage

Mid-turn `budgetTier` now uses `Math.max(tokensUsed, projected)` so a first
attempt with `tokensUsed === 0` can still reach `strict` and emit
`BUDGET_PROJECTED_EXCEED` from accumulated span data. Pre-turn tier still uses
committed `tokensUsed`. Updated [agentguard.md](agentguard.md).

## [2026-08-28] update | Visible short-secret skip and pre-truncate redaction

`registerSecretValues` now takes labeled config-field entries and reports
skipped values shorter than 8 characters without echoing the secret.
`AgentService.initialize` warns those field labels via `console.warn`. Codex
item previews redact before truncating to 200 characters. Updated
[agentguard.md](agentguard.md).

## [2026-08-28] update | Value-based trace redaction

Registered configured Ark and application auth credential values during
`AgentService.initialize`, before store initialization, so bare secret values
in command/output span attributes are scrubbed by literal match before
persistence. Pattern-based redaction remains for unknown credentials. Hardened
Codex JSONL parsing to ignore non-object roots. Updated
[agentguard.md](agentguard.md) and [index.md](index.md).

## [2026-08-28] ingest | Honest Codex leaf spans

Codex item completion events now preserve type-specific, truncated attributes,
mark non-zero command exits as errors, identify unrecognized items, and label
inter-item completion deltas as derived durations. Unrecognized items no longer
inflate tool-call budget projections. Updated [agentguard.md](agentguard.md) and
[index.md](index.md).

## [2026-08-28] ingest | Closed-loop failure span parenting

AgentGuard traces now form one tree rooted at `RUN_STARTED`. Failure `ERROR`
events parent incident, diagnosis, approval, and recovery activity; each error
remains under the failed turn or run, and successful recovery verification is
parented to the recovered turn. Run-scoped and checkpoint events now carry the
available run or turn parent plus retry attribution. Updated
[agentguard.md](agentguard.md) and [index.md](index.md).

## [2026-08-28] ingest | Measured AgentGuard turn spans

Each live runner attempt now opens a measured `TURN` span under `RUN_STARTED`,
parents emitted runner events to that turn, records usage on successful close,
and closes failed turns with their error. Quiet turns remain childless; the
previous synthesized `MODEL_CALL` fallback was removed. Updated
[agentguard.md](agentguard.md) and [index.md](index.md).

## [2026-08-27] update | Automated diagnosis

Added deterministic diagnosis to AgentGuard: `diagnostic.ts` issues a
`DiagnosisRecord` per incident (root cause, evidence, confidence, failure
signature + recurrence, template suggestions), DB v3 `diagnoses` column,
`GET /api/runs/:id/diagnoses`, verdict updates through the recovery lifecycle
(`acted` → `verified`/`aborted`/`awaiting_approval`, `DIAGNOSIS_ISSUED` /
`DIAGNOSIS_VERDICT` events), and a diagnosis card in the AgentGuard window that
also replaces the static "recovering…" text. Covered by `diagnostic.test.ts`
and integration tests. Updated [agentguard.md](agentguard.md) and
[api-and-data.md](api-and-data.md).

## [2026-08-27] ingest | Global AgentGuard settings

Runtime policy overrides persisted in JsonStore (`agentGuardSettings`);
`GET/PATCH/POST reset /api/agentguard/settings`. Frontend: dedicated
**AgentGuard policy** modal (playground Budget settings + window gear).
Env remains default; token budget applies to new runs; ratios live per turn.

## [2026-08-27] ingest | AgentGuard floating window

UI: AgentGuard evidence surface is a floating draggable/resizable window
(auto-open on active run + playground toggle). Docs: architecture one-pager.

## [2026-08-27] ingest | Proactive Budget Control implementation

Implemented `budget-policy.ts` and wired pre-turn wrap/gate, mid-turn
projection cancel, and `compress_resume` into `agent-service.ts`. Soft path
is automatic; hard exact exceed remains HITL. UI: tier badge + Inject projected.

## [2026-08-27] ingest | Proactive Budget Control (PRD/TRD)

Extended [AgentGuard PRD](../docs/AgentGuard%20PRD.md) and
[TRD](../docs/AgentGuard%20TRD.md) with BudgetPolicy: pre-turn prevention,
heuristic mid-turn cancel, deterministic compress-on-recovery (soft auto /
hard HITL). Updated [agentguard-architecture.md](../docs/agentguard-architecture.md)
and [agentguard.md](agentguard.md). Soft path not yet implemented in code.

## [2026-08-26] ingest | AgentGuard scope expansion

Documented budget guard, HITL approval, checkpointed retry, event export, and
POC `.env` parity. Added [agentguard.md](agentguard.md); linked architecture
one-pager [docs/agentguard-architecture.md](../docs/agentguard-architecture.md).

## [2026-08-25] bootstrap | Initial repository map

Created the wiki schema and initial pages from the repository README,
architecture documentation, server implementation, configuration, and
contribution guide.

## [2026-08-28] ingest | Restored-checkpoint spans and web test gate

`startCheckpointedRecovery` now appends `CHECKPOINT_RESTORED` after a successful
`restoreWorkspaceCheckpoint`, parented to the same failing span as
`RECOVERY_STARTED`, with `checkpointId` (and workspace/thread) metadata. Root
`npm test` / `npm run check` runs both workspaces. Kill-path crash classification
(`AgentRunner.kill`, non-zero exit wording on the persisted span) is covered by
an integration test.

Sources: [agent-service.ts](../apps/server/src/agent-service.ts),
[package.json](../package.json),
[agentguard.integration.test.ts](../apps/server/src/agentguard/agentguard.integration.test.ts).
