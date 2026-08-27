# AgentGuard

Reliability middleware layered on `AgentService`: structured traces, failure
classification, deterministic recovery from workspace + `codexThreadId`
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
| Detect | `runtime_crash`, `tool_timeout`, `budget_exceeded`, `budget_projected_exceeded`, … |
| Recover | `retry`, `restart_resume`, `compress_resume` restore latest checkpoint |
| Budget (hard) | `AGENTGUARD_TOKEN_BUDGET`; inject via `POST .../fail` `{type:budget_exceeded}` → HITL |
| Budget (soft) | BudgetPolicy tiers 50%/85%; prompt wrap; mid-turn projection cancel; `BUDGET_COMPRESSED` |
| HITL | `awaiting_approval` + `POST /api/runs/:id/approve`; second crash gated by `AGENTGUARD_REQUIRE_APPROVAL_AFTER_CRASHES` |
| UI | Floating AgentGuard window (drag/resize); timeline, budget meters/tier, Approve/Abort, export |
| Settings | Global policy modal + `GET/PATCH /api/agentguard/settings`; JsonStore overrides merge over env |

## Local POC parity

`scripts/start-local-poc.sh` loads repo `.env` so `ARK_BASE_URL` matches Compose.

## Implementation status note

Hard post-turn budget + HITL and soft BudgetPolicy (pre-turn wrap/gate,
mid-turn projection cancel, compress_resume) are implemented in
`budget-policy.ts` and `agent-service.ts`.
