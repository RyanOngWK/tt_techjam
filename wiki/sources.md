# Sources

The following tracked files are the initial source set for the wiki. They are
read-only inputs to wiki maintenance; implementation changes supersede wiki
claims until the relevant page is updated.

- [Repository README](../README.md): product scope, setup, and high-level behavior.
- [Architecture](../docs/ARCHITECTURE.md): component boundaries and trust model.
- [AgentGuard architecture one-pager](../docs/agentguard-architecture.md): middleware sketch for demos (ASCII + PNG).
- [AgentGuard architecture PNG](../docs/assets/agentguard-architecture.png): rendered one-page diagram.
- [Span taxonomy](../apps/server/src/agentguard/span-taxonomy.ts): category and actor assignment.
- [Span tree](../apps/server/src/agentguard/span-tree.ts): single-root tree builder from stored spans.
- [AgentGuard PRD](../docs/AgentGuard%20PRD.md) / [TRD](../docs/AgentGuard%20TRD.md): product and technical contracts.
- [Security policy](../SECURITY.md): proof-of-concept security constraints.
- [Contribution guide](../CONTRIBUTING.md): validation and documentation rules.
- [Fastify application](../apps/server/src/app.ts): HTTP API and request security.
- [Agent service](../apps/server/src/agent-service.ts): lifecycle and run orchestration.
- [Domain types](../apps/server/src/types.ts): persisted domain model and runner seam.
- [AgentGuard fixtures](../apps/server/fixtures/agentguard/): golden type sequences and tree-shape contracts.
- [Workspace manager](../apps/server/src/workspace.ts): agent workspace behavior.
- [Configuration](../apps/server/src/config.ts): environment contract and safeguards.
- [Runner factory](../apps/server/src/runner-factory.ts): runtime-provider selection.
- [Web application](../apps/web/src/App.tsx): browser client behavior.
- [Web types](../apps/web/src/types.ts): client `TraceEvent`, `SpanNode`, `SpanFilter`, and `RunListItem` shapes.
- [Web API client](../apps/web/src/api.ts): `request` helper, `listRuns`, `events`, `spanTree`.
- [Web span tree](../apps/web/src/span-tree.ts): intentional client duplicate of server tree-building plus `formatDuration`.
