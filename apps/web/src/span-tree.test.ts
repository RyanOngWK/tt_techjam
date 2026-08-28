import { describe, expect, it } from "vitest";
import { buildSpanTree, formatDuration } from "./span-tree";
import type { TraceEvent } from "./types";

function span(partial: Partial<TraceEvent> & { id: string; type: string }): TraceEvent {
  return {
    runId: "run-1",
    parentEventId: null,
    category: "orchestration",
    actor: "middleware",
    status: "ok",
    timestamp: "2026-08-28T04:00:00.000Z",
    endedAt: null,
    durationMs: null,
    durationSource: null,
    attemptIndex: 0,
    metadata: {},
    error: null,
    ...partial,
  };
}

describe("formatDuration", () => {
  it("renders null durations as an em dash", () => {
    expect(formatDuration(null, null)).toBe("—");
  });

  it("renders measured durations plainly", () => {
    expect(formatDuration(1500, "measured")).toBe("1.5s");
    expect(formatDuration(250, "measured")).toBe("250ms");
  });

  it("prefixes derived durations with a tilde", () => {
    expect(formatDuration(1500, "inter_item_delta")).toBe("~1.5s");
    expect(formatDuration(250, "inter_item_delta")).toBe("~250ms");
  });
});

describe("client buildSpanTree", () => {
  const TREE: TraceEvent[] = [
    span({ id: "run", type: "RUN_STARTED" }),
    span({ id: "turn", type: "TURN", parentEventId: "run" }),
    span({ id: "tool", type: "TOOL_CALL", category: "tool_call", actor: "agent", parentEventId: "turn" }),
    span({ id: "tool-error", type: "TOOL_CALL", category: "tool_call", actor: "agent", parentEventId: "turn", status: "error", error: "boom" }),
  ];

  it("keeps failing spans nested under dimmed ancestors for errors-only", () => {
    const roots = buildSpanTree(TREE, { status: ["error"] });
    expect(roots).toHaveLength(1);
    const run = roots[0]!;
    expect(run.matched).toBe(false);
    expect(run.children).toHaveLength(1);
    const turn = run.children[0]!;
    expect(turn.matched).toBe(false);
    expect(turn.children.map((child) => child.id)).toEqual(["tool-error"]);
    expect(turn.children[0]?.matched).toBe(true);
  });

  it("drops branches with no matching descendant", () => {
    const roots = buildSpanTree(TREE, { category: ["model_call"] });
    expect(roots).toEqual([]);
  });

  it("marks every span matched without a filter", () => {
    const roots = buildSpanTree(TREE);
    expect(roots[0]?.matched).toBe(true);
    expect(roots[0]?.children[0]?.children.every((child) => child.matched)).toBe(true);
  });
});
