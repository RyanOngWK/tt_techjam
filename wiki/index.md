# CodeJam Wiki

This wiki is the maintained map of Volc Agent Launchpad. Repository files are
the source of truth; this directory compiles their architecture and operational
knowledge for faster navigation and synthesis.

## Orientation

- [Overview](overview.md): purpose, scope, and current constraints.
- [Architecture](architecture.md): component boundaries and the request/run flow.
- [AgentGuard](agentguard.md): **Glass Box — trace and audit.** Reliability middleware: value- and pattern-redacted single-root causal span tree (`runId` = trace, `eventId` = span; category, actor, parent, attempt, qualified duration), diagnose, detect, recover, proactive budget, HITL. Real `runtime_crash` container kill when the container runner is active.

## System Areas

- [API and Data](api-and-data.md): HTTP surface, lifecycle states, and persistence.
- [Runtime and Deployment](runtime-and-deployment.md): execution providers,
  configuration, and deployment profiles.

## Provenance

- [Sources](sources.md): authoritative repository sources used by this wiki.
- [Log](log.md): chronological wiki maintenance record.
