# AgentGuard

Reliability middleware layered on `AgentService`: structured traces, failure
classification, **deterministic diagnosis** (root cause, evidence, signature,
recurrence, suggestions), recovery from workspace + `codexThreadId`
checkpoints, per-run token budget with **proactive BudgetPolicy** (pre-turn
prevention, heuristic mid-turn cancel, compress-on-recovery), and optional
operator approval for hard exceed / second crash.

## Sources

- [docs/agentguard-architecture.md](../docs/agentguard-architecture.md) — one-pager
- [docs/AgentGuard PRD.md](../docs/AgentGuard%20PRD.md)
- [docs/AgentGuard TRD.md](../docs/AgentGuard%20TRD.md)
- [apps/server/src/agentguard/](../apps/server/src/agentguard/)
- [apps/server/src/agent-service.ts](../apps/server/src/agent-service.ts)

## Behavior (current / planned)

| Capability | Notes |
| --- | --- |
| Trace | Redacted `TraceEvent`s; `GET /api/runs/:id/events?format=download` |
| Diagnose | Deterministic `DiagnosisRecord` per incident: root cause, evidence, confidence, failure signature + recurrence count, template suggestions; `GET /api/runs/:id/diagnoses` |
| Detect | `runtime_crash`, `tool_timeout`, `budget_exceeded`, `budget_projected_exceeded`, … |
| Recover | `retry`, `restart_resume`, `compress_resume` restore latest checkpoint; verdict updates the diagnosis (`acted` → `verified`/`aborted`/`awaiting_approval`) |
| Budget (hard) | `AGENTGUARD_TOKEN_BUDGET`; inject via `POST .../fail` `{type:budget_exceeded}` → HITL |
| Budget (soft) | BudgetPolicy tiers 50%/85%; prompt wrap; mid-turn projection cancel; `BUDGET_COMPRESSED` |
| HITL | `awaiting_approval` + `POST /api/runs/:id/approve`; second crash gated by `AGENTGUARD_REQUIRE_APPROVAL_AFTER_CRASHES` |
| UI | Floating AgentGuard window (drag/resize); timeline, diagnosis card, budget meters/tier, Approve/Abort, export |
| Settings | Global policy modal + `GET/PATCH /api/agentguard/settings`; JsonStore overrides merge over env |

## Diagnosis lifecycle

`handleFailure` classifies signals and issues a diagnosis alongside the
incident (`DIAGNOSIS_ISSUED`). A checkpointed recovery attaches a state delta
(checkpoint id, restored file count, session reattach, backoff, degraded flag)
and moves the diagnosis to `acted`. `RECOVERY_VERIFIED` / budget raise marks it
`verified`; abort marks it `aborted` (`DIAGNOSIS_VERDICT`); approval requests
mark it `awaiting_approval`. Diagnosis text is rule-based (ADR-001) and
redacted before persistence.

## Local POC parity

`scripts/start-local-poc.sh` loads repo `.env` so `ARK_BASE_URL` matches Compose.

## Implementation status note

Hard post-turn budget + HITL and soft BudgetPolicy (pre-turn wrap/gate,
mid-turn projection cancel, compress_resume) are implemented in
`budget-policy.ts` and `agent-service.ts`. Automated diagnosis
(`diagnostic.ts`, DB v3 `diagnoses`, `GET /api/runs/:id/diagnoses`, diagnosis
card UI) is implemented and covered by `diagnostic.test.ts` +
`agentguard.integration.test.ts`.
