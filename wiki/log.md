# Wiki Log

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
