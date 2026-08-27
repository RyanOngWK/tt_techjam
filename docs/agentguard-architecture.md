# AgentGuard architecture (one-pager)

**Track: Glass Box — trace and audit.**

AgentGuard represents an Agent Run as a **span tree** rather than a log stream.
It is not a separate product UI: the trace view is a **floating, draggable,
resizable window** inside the existing Playground (auto-opens on active runs;
toggle from the top bar).

The trace is the product. Failure detection, diagnosis, recovery, and budget
control are **consumers** of the span stream — they read spans to decide, and
write their decisions back as spans nested under the span that triggered them.

```text
┌─────────────┐     /api/*      ┌──────────────────┐
│  Web UI     │ ───────────────►│  Fastify control  │
│  (trace)    │◄── spans /      │  plane            │
└─────────────┘   approve/fail  └────────┬─────────┘
                                         │
                                         ▼
                               ┌──────────────────┐
                               │  AgentService     │
                               │  + TraceContext   │
                               │  (trust boundary) │
                               └────────┬─────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
         ┌──────────────────────┐              ┌──────────────────────┐
         │   SPAN COLLECTOR     │─── spans ───►│      CONSUMERS       │
         │  startSpan/endSpan   │              │  detector, diagnosis │
         │  category · actor    │◄── spans ────│  recovery, budget    │
         │  parent · attempt    │   (nested)   │  checkpoint          │
         │  redact before write │              │                      │
         └──────────┬───────────┘              └──────────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │  Span store (JSON)   │  runId = trace · eventId = span
         └──────────────────────┘
                    ▲
                    │ observedAt + redacted attributes
         ┌──────────┴───────────┐
         │  AgentRunner         │
         │  (Codex / Ark)       │
         └──────────────────────┘
```

## Span model

Every span carries a **category** (`orchestration`, `model_call`, `tool_call`,
`checkpoint`, `policy_decision`, `human_approval`, `recovery`), an **actor**
(`human`, `agent`, `middleware`), a **parent**, an **attempt index**, and a
**duration with its measurement source** recorded.

| Invariant | Enforcement |
| --- | --- |
| Every span has a category and actor | Type system + integration test |
| Parent chain is acyclic, roots at run | Tree builder + test |
| No fabricated telemetry | Test asserts no `metadata.synthesized` |
| Duration is measured, derived-and-labelled, or honestly null | `durationSource` field |
| Secrets redacted before persistence | Redactor + env-scan test |

## Trust boundary

Secrets and model credentials stay on the server. Span attributes are redacted
before persistence, not merely before display. The browser receives only
sanitized spans, incidents, and run status.

## The closed loop

```text
TOOL_CALL  npm test        tool_call       agent       ~2.1s   error (exit 1)
├─ INCIDENT_OPENED         policy_decision middleware
├─ DIAGNOSIS_ISSUED        policy_decision middleware  confidence 0.9
└─ RECOVERY_STARTED        recovery        middleware  1.3s
   └─ CHECKPOINT_RESTORED  checkpoint      middleware
TURN #1                    orchestration   middleware  3.1s
└─ RECOVERY_VERIFIED       recovery        middleware
```

Detection and repair are **children of the span that failed**, so a reviewer sees
the whole loop in one tree rather than correlating separate panels. This is the
evidence that the trace is precise enough to drive automated control — the
distinction the official brief draws between middleware and a dashboard.

## Adjacent controls (same story)

| Control | Behavior |
| --- | --- |
| Real crash injection | `docker kill` on the runtime container; Codex exits non-zero; the error span is genuine |
| Mid-turn projection | Cancel decision made from accumulated span counts, not committed usage |
| Soft budget tiers | At 50% / 85%: auto prompt wrap; emit `BUDGET_SOFT_LIMIT` |
| Hard token budget | Exact `tokensUsed` vs `tokenBudget` → pause for approve or abort + ALERT |
| HITL | Approval spans attribute the decision to actor `human` |
| Query and export | Filter by category / actor / status / time; `tree=true`; `?format=download` |

## Demo beats

1. Real task → span tree with durations, commands, exit codes, per-turn usage
2. Filter to errors only; expand a tool span to show redacted attributes
3. Kill the container → the tool span turns red on its own
4. Diagnosis and recovery appear nested beneath it → `RECOVERY_VERIFIED`
5. Run list across all agents → export JSON → follow-up message still works

See [AgentGuard TRD](AgentGuard%20TRD.md) for APIs and ADRs, and the
[span model design](superpowers/specs/2026-08-27-glass-box-span-model-design.md)
for the technical design of record.
