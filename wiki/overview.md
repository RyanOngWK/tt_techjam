# Overview

Volc Agent Launchpad is a single-user, single-node agent control-plane starter
kit for short middleware hackathons. It offers a React browser UI, a Fastify
control plane, persistent agent workspaces and Codex sessions, and Volcengine
Ark-backed Codex execution. The selected middleware track is **Glass Box —
trace and audit** (AgentGuard span tree). [README](../README.md) | [Architecture source](../docs/ARCHITECTURE.md) | [AgentGuard](agentguard.md)

## What It Manages

- Agents with a name, description, instructions, lifecycle status, workspace,
  and resumable Codex thread.
- Asynchronous runs and their user/assistant messages.
- Workspace creation, instruction-file generation, and archival after deletion.
- Local process and disposable-container execution profiles.

See [API and Data](api-and-data.md) for the persisted model and [Runtime and
Deployment](runtime-and-deployment.md) for execution details.

## Boundaries

- The system is intentionally a proof of concept, not a multi-tenant platform.
- The optional bearer token protects a remote demo but is not user identity or
  authorization.
- A single JSON store is safe only for one process.
- The container or ECS instance is the trust boundary; ordinary containers are
  not hardened tenant isolation.

Sources: [Security policy](../SECURITY.md), [Architecture source](../docs/ARCHITECTURE.md), [Store implementation](../apps/server/src/store.ts).
