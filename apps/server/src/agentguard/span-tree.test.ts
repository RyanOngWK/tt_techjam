import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../types.js";
import { buildSpanTree, matchesFilter, summarizeRun } from "./span-tree.js";

function span(overrides: Partial<TraceEvent> & { id: string }): TraceEvent {
  return {
    runId: "run-1",
    parentEventId: null,
    type: "TOOL_CALL",
    category: "tool_call",
    actor: "agent",
    status: "ok",
    timestamp: "2026-08-27T10:00:00.000Z",
    endedAt: null,
    durationMs: null,
    durationSource: null,
    attemptIndex: 0,
    metadata: {},
    error: null,
    ...overrides,
  };
}

const TREE: TraceEvent[] = [
  span({ id: "run", type: "RUN_STARTED", category: "orchestration", actor: "human", timestamp: "2026-08-27T10:00:00.000Z" }),
  span({ id: "turn", type: "TURN", category: "orchestration", actor: "middleware", parentEventId: "run", timestamp: "2026-08-27T10:00:01.000Z" }),
  span({ id: "model", type: "MODEL_CALL", category: "model_call", parentEventId: "turn", timestamp: "2026-08-27T10:00:02.000Z" }),
  span({ id: "tool", parentEventId: "turn", status: "error", timestamp: "2026-08-27T10:00:03.000Z" }),
  span({ id: "incident", type: "INCIDENT_OPENED", category: "policy_decision", actor: "middleware", parentEventId: "tool", timestamp: "2026-08-27T10:00:04.000Z" }),
];

describe("span tree", () => {
  it("nests spans by parent and returns a single root", () => {
    const roots = buildSpanTree(TREE);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe("run");
    expect(roots[0]?.children[0]?.id).toBe("turn");
    expect(roots[0]?.children[0]?.children.map((c) => c.id)).toEqual(["model", "tool"]);
    expect(roots[0]?.children[0]?.children[1]?.children[0]?.id).toBe("incident");
  });

  it("marks every span matched when no filter is supplied", () => {
    const roots = buildSpanTree(TREE);
    expect(roots[0]?.matched).toBe(true);
    expect(roots[0]?.children[0]?.matched).toBe(true);
  });

  it("keeps non-matching ancestors as unmatched scaffolding", () => {
    const roots = buildSpanTree(TREE, { status: ["error"] });
    expect(roots).toHaveLength(1);
    const run = roots[0]!;
    expect(run.matched).toBe(false);
    const turn = run.children[0]!;
    expect(turn.matched).toBe(false);
    expect(turn.children).toHaveLength(1);
    expect(turn.children[0]?.id).toBe("tool");
    expect(turn.children[0]?.matched).toBe(true);
  });

  it("drops branches with no matching descendant", () => {
    const roots = buildSpanTree(TREE, { category: ["model_call"] });
    const turn = roots[0]!.children[0]!;
    expect(turn.children.map((child) => child.id)).toEqual(["model"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(buildSpanTree(TREE, { actor: ["human"], status: ["error"] })).toEqual([]);
  });

  it("treats a span with a missing parent as a root", () => {
    const orphan = [span({ id: "lonely", parentEventId: "gone" })];
    expect(buildSpanTree(orphan).map((node) => node.id)).toEqual(["lonely"]);
  });

  it("breaks parent cycles instead of recursing forever", () => {
    const cyclic = [
      span({ id: "a", parentEventId: "b" }),
      span({ id: "b", parentEventId: "a" }),
    ];
    const roots = buildSpanTree(cyclic);
    expect(roots.length).toBeGreaterThan(0);
  });

  it("composes filters with AND", () => {
    const event = span({ id: "x", status: "error", actor: "agent" });
    expect(matchesFilter(event, { status: ["error"], actor: ["agent"] })).toBe(true);
    expect(matchesFilter(event, { status: ["error"], actor: ["human"] })).toBe(false);
  });

  it("filters by since timestamp", () => {
    const event = span({ id: "x", timestamp: "2026-08-27T10:00:03.000Z" });
    expect(matchesFilter(event, { since: "2026-08-27T10:00:02.000Z" })).toBe(true);
    expect(matchesFilter(event, { since: "2026-08-27T10:00:04.000Z" })).toBe(false);
  });

  it("summarises span count, error count, and wall duration", () => {
    const summary = summarizeRun(TREE);
    expect(summary.spanCount).toBe(5);
    expect(summary.errorCount).toBe(1);
    expect(summary.durationMs).toBe(4000);
  });

  it("returns a null duration for an empty run", () => {
    expect(summarizeRun([])).toEqual({ spanCount: 0, errorCount: 0, durationMs: null });
  });
});
