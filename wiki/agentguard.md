# AgentGuard

Reliability middleware layered on `AgentService`: structured traces, failure
classification, deterministic recovery from workspace + `codexThreadId`
checkpoints, per-run token budget, and optional operator approval.

## Sources

- [docs/agentguard-architecture.md](../docs/agentguard-architecture.md) — one-pager
- [docs/AgentGuard PRD.md](../docs/AgentGuard%20PRD.md)
- [docs/AgentGuard TRD.md](../docs/AgentGuard%20TRD.md)
- [apps/server/src/agentguard/](../apps/server/src/agentguard/)
- [apps/server/src/agent-service.ts](../apps/server/src/agent-service.ts)

## Behavior (current)

| Capability | Notes |
| --- | --- |
| Trace | Redacted `TraceEvent`s; `GET /api/runs/:id/events?format=download` |
| Detect | `runtime_crash`, `tool_timeout`, `budget_exceeded`, … |
| Recover | `retry` and `restart_resume` both restore latest checkpoint |
| Budget | `AGENTGUARD_TOKEN_BUDGET`; inject via `POST .../fail` `{type:budget_exceeded}` |
| HITL | `awaiting_approval` + `POST /api/runs/:id/approve`; second crash gated by `AGENTGUARD_REQUIRE_APPROVAL_AFTER_CRASHES` |
| UI | Timeline failing-step highlight, budget meters, Approve/Abort, export |

## Local POC parity

`scripts/start-local-poc.sh` loads repo `.env` so `ARK_BASE_URL` matches Compose.
