# Wiki Log

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
