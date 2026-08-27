# AgentGuard architecture (one-pager)

AgentGuard is reliability middleware between the Playground UI and the Codex /
Ark runtime. It is not a separate product UI: the dashboard is a **floating,
draggable, resizable evidence window** for traces, incidents, budgets, and
recovery (auto-opens on active runs; toggle from the playground top bar).

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
     trace / detect / recover / verify / BudgetPolicy
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
     TraceEvent store           Failure policy              Checkpoint store
     (runId = trace)            retry / restart_resume      workspace +
     (eventId = span)           compress_resume /           codexThreadId
                                abort + ALERT
                                budget soft + HITL
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
restart_resume share that path. On `budget_projected_exceeded`, policy restores
the checkpoint and applies a **deterministic compress wrap** (`compress_resume`)
without operator approval.

## Adjacent controls (same story)

| Control | Behavior |
| --- | --- |
| Soft budget tiers | At 50% / 85% usage: auto prompt wrap; emit `BUDGET_SOFT_LIMIT` |
| Mid-turn projection | At strict tier: span+byte heuristic; cancel Codex if projected exceed → `BUDGET_PROJECTED_EXCEED` + compress |
| Hard token budget | Exact `tokensUsed` vs `tokenBudget`; `budget_exceeded` → pause for approve (raise budget) or abort + ALERT |
| HITL | Second crash (configurable) or exact budget exceed → `awaiting_approval` until `POST /api/runs/:id/approve` |
| Evidence export | `GET /api/runs/:id/events?format=download` |

## Demo beats

1. Real task → timeline spans + checkpoints  
2. Inject crash or timeout → incident + checkpoint restore  
3. Soft budget / compress events **or** inject exact budget / second crash → approval gate  
4. Export JSON → post-recovery controllability (follow-up message)

See [AgentGuard TRD](AgentGuard%20TRD.md) for APIs and ADRs.
