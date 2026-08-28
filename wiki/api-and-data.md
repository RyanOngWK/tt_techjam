# API and Data

## HTTP Surface

The API exposes health and authentication discovery, system information, agent
CRUD and lifecycle actions, messages, agent-scoped run history, a global run
list, individual run lookup, and AgentGuard evidence: trace events, incidents,
recovery attempts, and automated diagnoses. Message submission returns `202
Accepted` because execution is asynchronous. Request payloads and path IDs are
validated with Zod.

`GET /api/runs` returns `{ runs }` newest-first, each with `spanCount`,
`errorCount`, `incidentCount`, `durationMs`, `tokensUsed`, `tokenBudget`, and
`agentName`. `GET /api/runs/:id/events` returns `{ events }` and accepts
`category`, `actor`, `status`, `since`, and `tree=true` (nested span tree with
`children` and `matched`); `format=json|download` still attaches a JSON file.
Comma-separated filter values are allowed. Responses are envelope objects, not
bare arrays.

Source: [Fastify application](../apps/server/src/app.ts) | [AgentService](../apps/server/src/agent-service.ts) | [Span tree](../apps/server/src/agentguard/span-tree.ts)

## Lifecycle

An agent has `ready`, `busy`, `stopped`, or `error` status. A run has `queued`,
`running`, `completed`, `failed`, or `cancelled` status. The service prevents a
second run while the agent is busy. On startup, queued/running runs are marked
cancelled and busy agents return to ready.

Source: [AgentService](../apps/server/src/agent-service.ts) | [Domain types](../apps/server/src/types.ts)

## Persistence and Workspaces

`JsonStore` keeps agents, messages, and runs in one versioned JSON database and
serializes mutations before atomically replacing the file. Each agent gets a
workspace containing generated `AGENTS.md`, a basic `.gitignore`, and a README.
Deleting an agent moves its workspace under `.deleted/` before removing its
metadata.

Source: [JSON store](../apps/server/src/store.ts) | [Workspace manager](../apps/server/src/workspace.ts)
