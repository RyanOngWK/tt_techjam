# Design: Glass Box span model

**Date:** 2026-08-27
**Track:** Glass Box — trace and audit
**Status:** Approved, pending implementation plan

## 1. Problem

AgentGuard already emits structured events, opens incidents, runs deterministic
recovery, and enforces token budgets. But the trace primitive underneath all of
it is weak in ways that matter for a track judged on trace quality:

- `TraceEvent.durationMs` is declared and never written. Every event in the
  store has `durationMs: null` ([trace-collector.ts](../../../apps/server/src/agentguard/trace-collector.ts)).
- `TraceEvent.parentEventId` is declared and never written. There is no span
  tree; the UI carries a `· child` label that can never render
  ([App.tsx:1175](../../../apps/web/src/App.tsx)).
- The runner hardcodes `status: "ok"` on every span and funnels unrecognized
  Codex item types into `TOOL_CALL`, so genuine in-turn failures never appear as
  errors and the tool-call count feeding budget projection is inflated
  ([codex-runner.ts:46-79](../../../apps/server/src/codex-runner.ts)).
- When Codex JSONL is sparse, `AgentService` fabricates a `MODEL_CALL` span
  marked `synthesized: true` ([agent-service.ts:555-568](../../../apps/server/src/agent-service.ts)).
  A trace product that invents spans undermines the submission.
- Spans carry no category or actor attribution, so orchestration, model calls,
  policy decisions, and human approvals are indistinguishable in structure.

The official brief for this direction (see [TechJam_Info.md](../../TechJam_Info.md)
§"Trace, Audit, and Observability") names duration, retry and cancellation
relationships, span categories, actor type, and a tree view with expandable
spans and status filters. Roughly half of that list is currently unmet.

## 2. Positioning

The trace is the product. Recovery, diagnosis, and budget control are
**consumers** of the trace, and their presence is the argument that the trace is
good enough to act on rather than merely display. This distinguishes the
submission from a dashboard, which the brief explicitly says does not count as
middleware.

The demo artifact is a single trace tree in which a failing span contains its own
diagnosis, recovery, checkpoint restore, and verification as nested children.

## 3. Span model

### 3.1 New enums

```ts
export type SpanCategory =
  | "orchestration"    // run, turn
  | "model_call"
  | "tool_call"
  | "checkpoint"
  | "policy_decision"  // incident opened, diagnosis issued, budget decision
  | "human_approval"
  | "recovery";

export type ActorType = "human" | "agent" | "middleware";

export type DurationSource = "measured" | "inter_item_delta";
```

`SpanCategory` maps directly onto the brief's named categories. `ActorType`
answers the brief's "actor type" identifier. `DurationSource` is described in
§3.3.

### 3.2 TraceEvent

| Field | Type | Change | Notes |
| --- | --- | --- | --- |
| `id` | string | existing | span id |
| `runId` | string | existing | trace id |
| `parentEventId` | string \| null | **now populated** | parent span |
| `type` | EventType | existing | |
| `category` | SpanCategory | **new** | |
| `actor` | ActorType | **new** | |
| `status` | EventStatus | existing | `ok` \| `error` \| `running` |
| `timestamp` | string (ISO) | existing | span start |
| `endedAt` | string \| null | **new** | span end; null for point-in-time events |
| `durationMs` | number \| null | **now populated** | |
| `durationSource` | DurationSource \| null | **new** | |
| `attemptIndex` | number | **new** | recovery attempt this span belongs to |
| `metadata` | object (redacted) | existing | |
| `error` | string \| null (redacted) | existing | |

`attemptIndex` is the brief's "retry relationship": every span is attributable to
a specific attempt, so a reviewer can see which work was redone after recovery.

A new `EventType` value `TURN` is added (§3.5).

### 3.3 Duration and honesty

Codex emits `item.completed` but no `item.started`
([codex-runner.ts:93](../../../apps/server/src/codex-runner.ts)), so
JSONL-derived child spans have no observable start time.

- `durationSource: "measured"` — the middleware controls both ends and wraps the
  operation in wall-clock timing. Applies to `TURN`, recovery, and checkpoint
  spans.
- `durationSource: "inter_item_delta"` — duration is the interval since the
  previous observed item. Applies to model and tool spans derived from JSONL.

The runner stamps `observedAt` at the moment it parses each line, before any
async store write, so deltas are not polluted by persistence latency. The UI
renders `inter_item_delta` durations with a `~` prefix.

Rationale: a qualified number is more useful and more honest than either a null
or a falsely precise one. Recorded as ADR-012.

### 3.4 Tree shape

```
RUN_STARTED                     orchestration    human
└─ TURN #0                      orchestration    middleware   4.2s
   ├─ MODEL_CALL                model_call       agent        ~0.8s
   ├─ TOOL_CALL  npm test       tool_call        agent        ~2.1s   error
   │  ├─ INCIDENT_OPENED        policy_decision  middleware
   │  ├─ DIAGNOSIS_ISSUED       policy_decision  middleware
   │  └─ RECOVERY_STARTED       recovery         middleware   1.3s
   │     ├─ CHECKPOINT_RESTORED checkpoint       middleware
   │     └─ APPROVAL_REQUESTED  human_approval   human
   └─ CHECKPOINT_CREATED        checkpoint       middleware
└─ TURN #1                      orchestration    middleware   3.1s
   ├─ MODEL_CALL                model_call       agent        ~0.9s
   └─ RECOVERY_VERIFIED         recovery         middleware
RUN_COMPLETED                   orchestration    middleware
```

Recovery, diagnosis, budget, and approval events become children of the span that
caused them rather than entries in parallel side lists.

### 3.5 Turn spans replace the synthetic span

The `synthesized: true` block is deleted. `this.runner.run(...)` is wrapped in
`startSpan` / `endSpan`, producing a `TURN` span per attempt with:

- measured wall-clock duration
- `attemptIndex`
- budget tier applied and whether the prompt was wrapped
- `codexThreadId`
- `result.usage` for that turn

This provides the guarantee the hack was reaching for — at least one span always
exists per turn — using real data, and attributes token usage to the turn that
spent it rather than only to the run header.

## 4. Collector API

`trace-collector.ts` gains a span lifecycle alongside the existing point-in-time
function.

```ts
startSpan(store, {
  runId, type, category, actor, parentEventId, attemptIndex, metadata,
}): Promise<string>          // writes status:"running", returns span id

endSpan(store, spanId, {
  status, error, metadata, durationSource,
}): Promise<void>            // patches endedAt, durationMs, status

appendTraceEvent(store, {...}): Promise<TraceEvent>
                             // point-in-time; durationMs stays null honestly
```

`endSpan` needs an internal `updateTraceEvent` that locates the event inside
`store.mutate` and patches it. `JsonStore.mutate` already hands the caller a
mutable database clone ([store.ts:78](../../../apps/server/src/store.ts)), so no
store API change is required.

Point-in-time events keep `durationMs: null` legitimately. The distinction
between "no duration because it is instantaneous" and "no duration because we
never recorded it" becomes explicit in the type.

### 4.1 Parent tracking

An explicit `TraceContext` is threaded through `executeRun`:

```ts
interface TraceContext {
  runId: string;
  runSpanId: string;
  turnSpanId: string | null;
  failingSpanId: string | null;
  attemptIndex: number;
}
```

No async-local-storage. Explicit parameters stay testable and readable at this
size, and the parent for any given emission site is unambiguous.

## 5. Runner instrumentation

`mapItemToStreamEvent` becomes a per-item-type extractor emitting redacted
structured attributes and a real status.

| Codex item | Attributes | Status source |
| --- | --- | --- |
| `command_execution` | command (redacted, 200 chars), exit code, output preview | exit code ≠ 0 → `error` |
| `file_change` | workspace-relative paths, change kinds, count | reported errors |
| `mcp_tool_call` | server name, tool name | reported result |
| `agent_message`, `reasoning` | text preview | `ok` |
| unrecognized | raw type, `unrecognized: true` | `ok`, excluded from projection |

Two consequences beyond richer metadata:

1. In-turn failures become error spans without requiring injection, so "locate
   the failing step" works on organic failures.
2. Unrecognized items stop inflating the tool-call count that feeds
   `projectUsage`, and become visible as unrecognized rather than disguised as
   tool calls.

`RunnerStreamEvent` gains `category`, `observedAt`, and richer `metadata`.

## 6. Real failure injection

`ContainerCodexRunner.cancel` already force-removes the container
([container-codex-runner.ts:116](../../../apps/server/src/container-codex-runner.ts)).
A sibling `kill(agentId)` performs the same removal **without** setting
`cancelled = true`, so the child process exits non-zero and `classifyFailure`
receives a genuine "exited with code" signal rather than an injected flag.

`POST /api/runs/:id/fail` with `{ "type": "runtime_crash" }` routes to `kill`
when the container runner is active, falling back to the existing simulated path
for the local process runner. The resulting trace contains a real error span with
a real exit code, and the diagnosis engine's exit-code-137 OOM branch
([diagnostic.ts:132-139](../../../apps/server/src/agentguard/diagnostic.ts))
becomes reachable with real data.

## 7. Budget tier fix

Mid-turn tier evaluation currently reads `liveRun.tokensUsed`
([agent-service.ts:514](../../../apps/server/src/agent-service.ts)), which is
only incremented after a turn completes ([agent-service.ts:579](../../../apps/server/src/agent-service.ts)).
Since runs start at `tokensUsed: 0` ([agent-service.ts:357](../../../apps/server/src/agent-service.ts))
and `shouldCancelMidTurn` requires the `strict` tier
([budget-policy.ts:57](../../../apps/server/src/agentguard/budget-policy.ts)),
mid-turn cancellation is unreachable on a first attempt.

Fix: evaluate the tier against `Math.max(tokensUsed, projected)` during a turn.
Committed usage remains authoritative for the post-turn hard gate.

In Glass Box terms this is not a budget feature — it demonstrates that the span
stream drives a live control decision.

## 8. APIs

| Method | Path | Change |
| --- | --- | --- |
| GET | `/api/runs` | **new** — global run list, newest first, with per-run summary (span count, error count, duration, tokens, incident count) |
| GET | `/api/runs/:id/events` | gains `category`, `status`, `actor`, `since`, `tree=true` filters; `format=download` unchanged |

`tree=true` returns spans nested by `parentEventId` rather than flat. The brief
lists a machine-readable query interface as an optional extension; it is close to
free once spans are structured.

**Filtering preserves hierarchy.** A non-matching span is still returned when a
descendant matches, so a match never loses its position in the run. Each span in
tree mode carries `matched: boolean` — `true` renders normally, `false` renders
as dimmed, non-interactive scaffolding. Branches with no match are omitted.

Rejected alternatives: flatten to matches (loses position in the run), and
flatten with breadcrumb paths (keeps orientation but still discards the tree at
the exact moment a reviewer clicks "errors only"). Recorded as ADR-018.

## 9. UI

The floating window is retained as the trace detail view — the "not a separate
product" property from [agentguard-architecture.md](../../agentguard-architecture.md)
is preserved deliberately. The run list becomes a tab within it.

- **Run list tab** — all runs across all agents, newest first, showing status,
  duration, error count, and tokens. Selecting a run loads its trace.
- **Trace tree** — indentation derived from `parentEventId`, expand/collapse per
  span. Rows show category, actor badge, type, status, and duration (`~` prefix
  for `inter_item_delta`).
- **Expandable spans** — clicking a span reveals its full redacted metadata.
- **Filter chips** — errors only, by category, by actor.
- **Jump to failing step** — retained, now driven by the first error span rather
  than only an open incident, so it works on failures that never became
  incidents.
- **Run header** — budget meter, tier badge, and usage are unchanged.

## 10. Testing

### Unit

- Span lifecycle: `startSpan` writes `running`; `endSpan` sets `endedAt`,
  `durationMs`, final status.
- Tree builder: nesting, ordering, orphan handling, cycle rejection.
- Category and actor assignment for every emission site.
- Runner item mapping including non-zero exit codes and unrecognized types.
- Budget tier against projected usage.

### Integration

- A completed run produces a well-formed tree: every span has non-null
  `category` and `actor`; the parent chain is acyclic and roots at the run span;
  no span has `metadata.synthesized`.
- An injected crash produces an error span with children for incident,
  diagnosis, recovery, and verification.
- Mid-turn cancellation fires on a first attempt under a low budget without
  injection.

### Redaction evidence

A test that serializes every event of a completed run and asserts that no value
from `process.env` under a secret-shaped key appears anywhere in the output. This
is stronger evidence than fixture-string matching and directly answers the
"no secrets in traces" acceptance item.

### Fixtures

Existing golden fixtures under
[apps/server/fixtures/agentguard/](../../../apps/server/fixtures/agentguard/)
assert event type sequences. They are extended to assert category, actor, and
parent shape. Note: the TRD currently names these as `.jsonl` at repo root; the
actual files are `.json` under `apps/server/`. The TRD is corrected rather than
the files moved.

## 11. Work split

Two people, three days. The contract between them is the `TraceEvent` shape and
the `tree=true` response, both fixed on day 1 morning so the frontend can build
against fixtures immediately.

| Day | Server | Web |
| --- | --- | --- |
| 1 | Types, enums, span lifecycle in collector, `TraceContext`, turn spans, delete synthetic span | Shared types, API client, tree builder from flat events, run list tab shell |
| 2 | Runner instrumentation, real container kill, budget tier fix, run list and filter APIs | Tree rendering, expandable spans, filter chips, duration display, actor badges |
| 3 | Tests, fixtures, redaction evidence test | Polish, screenshots, architecture diagram, demo rehearsal |

Documentation updates (PRD, TRD, architecture one-pager, README) are day 3 and
shared.

## 12. Out of scope

Deliberately cut, with reasons:

- **Hash-chained tamper-evident log and signed exports** — strong for audit, but
  they do not serve any Glass Box demo beat.
- **OpenTelemetry / OTLP export** — production distributed tracing is already
  out of scope per TRD §16.
- **LLM-based trace summarization** — conflicts with ADR-001 determinism.
- **Cross-process trace recovery** — separate concern from the span model.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Span refactor breaks existing recovery paths | 59 existing tests plus golden fixtures run before and after each step |
| Legacy events in `data/launchpad.json` lack new fields | Extend the existing normalization path (`agent-service.ts:120` pattern) to default `category`, `actor`, `attemptIndex` on read |
| `inter_item_delta` durations look wrong under load | Labelled in data and visually distinguished in the UI; measured spans carry the load-bearing numbers |
| Real container kill is flaky across Docker/Colima/Podman | Fall back to the existing simulated path when the container runner is unavailable |
| Tree rendering scope creep | Expand/collapse and filters only; no virtualization, no search |

## 14. New ADRs

- **ADR-012 (Qualified duration):** Durations record their measurement source;
  JSONL-derived spans use inter-item deltas and are marked as such.
- **ADR-013 (Actor attribution):** Every span records whether a human, the
  agent, or the middleware acted.
- **ADR-014 (No synthetic spans):** The middleware never fabricates telemetry.
  Coverage guarantees come from spans the middleware genuinely owns.
- **ADR-015 (Real failure injection):** Crash injection kills the runtime
  container so classification consumes genuine exit codes.
