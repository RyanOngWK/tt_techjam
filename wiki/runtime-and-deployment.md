# Runtime and Deployment

## Execution Providers

`createRunner` selects `ContainerCodexRunner` when `RUNTIME_PROVIDER=container`;
otherwise it selects `CodexRunner`. Both are implementations of `AgentRunner`
and receive the workspace, prompt, and prior Codex thread ID from the service.
Optional `kill` is used by `runtime_crash` injection: the container runner
force-removes the active container without setting `cancelled`; the local
process runner delegates to `cancel`.

- Local POC: host Node.js control plane with one disposable Docker, Colima, or
  Podman container per turn.
- Local development: host Node.js and host Codex process.
- ECS: application container and a Codex child process in that container.

Sources: [Runner factory](../apps/server/src/runner-factory.ts) | [Architecture source](../docs/ARCHITECTURE.md) | [Local POC guide](../docs/LOCAL_POC.md)

## Configuration

Environment configuration validates network settings, storage locations, Codex
sandbox and time/output limits, runtime resource limits, Ark settings, and
optional application authentication. A non-loopback production server requires
a sufficiently long `APP_AUTH_TOKEN`. `ARK_API_KEY` and `ARK_MODEL` must both
be configured before runs are accepted.

Source: [Configuration](../apps/server/src/config.ts) | [Example environment](../.env.example)

## Operational Constraints

Runtime controls bound process output, time, and container resources, but they
do not provide hardened multi-tenant isolation. The project documentation warns
against using production data or credentials in this proof of concept.

Sources: [Security policy](../SECURITY.md) | [Architecture source](../docs/ARCHITECTURE.md)
