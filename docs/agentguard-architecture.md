# AgentGuard architecture (one-pager)

AgentGuard is reliability middleware between the Playground UI and the Codex /
Ark runtime. It is not a separate product UI: the dashboard is an evidence
surface for traces, incidents, budgets, and recovery.

```text
┌─────────────┐     /api/*      ┌──────────────────┐
│  Web UI     │ ───────────────►│  Fastify control  │
│  (evidence) │◄── events/      │  plane            │
└─────────────┘   approve/fail  └────────┬─────────┘
                                         │
                                         ▼
                               ┌──────────────────┐
                               │  AgentService     │
                               │  + AgentGuard     │
                               │  (trust boundary) │
                               └────────┬─────────┘
                    trace / detect / recover / verify
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
     TraceEvent store           Failure policy              Checkpoint store
     (runId = trace)            retry / restart_resume      workspace +
     (eventId = span)           abort + ALERT               codexThreadId
                                budget + HITL
                                         │
                                         ▼
                               ┌──────────────────┐
                               │  AgentRunner     │
                               │  (Codex / Ark)   │
                               └──────────────────┘
```

## Trust boundary

Secrets and model credentials stay on the server. Trace metadata is redacted
before persistence and API responses. The browser only receives sanitized
events, incidents, and run status.

## Recovery point

After successful model/tool spans, AgentGuard writes a **checkpoint**
(workspace snapshot + `codexThreadId`). On `tool_timeout` or `runtime_crash`,
policy restores the latest checkpoint before re-issuing the prompt. Retry and
restart_resume share that path.

## Adjacent controls (same story)

| Control | Behavior |
| --- | --- |
| Token budget | `tokensUsed` vs `tokenBudget`; `budget_exceeded` → pause for approve (raise budget) or abort + ALERT |
| HITL | Second crash (configurable) or budget exceed → `awaiting_approval` until `POST /api/runs/:id/approve` |
| Evidence export | `GET /api/runs/:id/events?format=download` |

## Demo beats

1. Real task → timeline spans + checkpoints  
2. Inject crash or timeout → incident + checkpoint restore  
3. Inject budget / second crash → approval gate  
4. Export JSON → post-recovery controllability (follow-up message)

See [AgentGuard TRD](AgentGuard%20TRD.md) for APIs and ADRs.
