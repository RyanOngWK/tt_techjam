import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildActiveFilter, SpanRow } from "./App";
import type { SpanNode } from "./types";

function span(partial: Partial<SpanNode> & Pick<SpanNode, "id" | "type">): SpanNode {
  return {
    runId: "run-1",
    parentEventId: null,
    category: "orchestration",
    actor: "middleware",
    status: "ok",
    timestamp: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.500Z",
    durationMs: 1500,
    durationSource: "measured",
    attemptIndex: 0,
    metadata: {},
    error: null,
    matched: true,
    children: [],
    ...partial,
  };
}

describe("SpanRow", () => {
  it("renders type, actor badge, status, and measured duration", () => {
    const html = renderToStaticMarkup(
      <SpanRow
        node={span({ id: "root", type: "TURN", actor: "agent", durationMs: 1500, durationSource: "measured" })}
        depth={0}
        expanded={new Set(["root"])}
        onToggle={() => undefined}
        failingEventId={null}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("TURN");
    expect(html).toContain('class="span-actor is-agent"');
    expect(html).toContain("agent");
    expect(html).toContain('class="span-status is-ok"');
    expect(html).toContain("1.5s");
    expect(html).not.toContain("~1.5s");
  });

  it("nests children when expanded and prefixes derived durations with a tilde", () => {
    const root = span({
      id: "turn",
      type: "TURN",
      children: [
        span({
          id: "tool",
          type: "TOOL_CALL",
          actor: "agent",
          category: "tool_call",
          durationMs: 250,
          durationSource: "inter_item_delta",
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <SpanRow
        node={root}
        depth={0}
        expanded={new Set(["turn", "tool"])}
        onToggle={() => undefined}
        failingEventId={null}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("TURN");
    expect(html).toContain("TOOL_CALL");
    expect(html).toContain("~250ms");
    expect(html).toContain("padding-left:18px");
  });

  it("hides children when the parent is collapsed", () => {
    const root = span({
      id: "turn",
      type: "TURN",
      children: [span({ id: "tool", type: "TOOL_CALL" })],
    });

    const html = renderToStaticMarkup(
      <SpanRow
        node={root}
        depth={0}
        expanded={new Set()}
        onToggle={() => undefined}
        failingEventId={null}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("TURN");
    expect(html).not.toContain("TOOL_CALL");
  });

  it("marks the failing error span for jump-to-step", () => {
    const html = renderToStaticMarkup(
      <SpanRow
        node={span({
          id: "err",
          type: "ERROR",
          status: "error",
          error: "boom",
        })}
        depth={0}
        expanded={new Set(["err"])}
        onToggle={() => undefined}
        failingEventId="err"
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain('id="agentguard-failing-step"');
    expect(html).toContain("is-failing");
    expect(html).toContain("is-error");
    expect(html).toContain("boom");
  });

  it("dims unmatched scaffold rows", () => {
    const html = renderToStaticMarkup(
      <SpanRow
        node={span({ id: "scaffold", type: "RUN_STARTED", matched: false })}
        depth={0}
        expanded={new Set(["scaffold"])}
        onToggle={() => undefined}
        failingEventId={null}
        selected={null}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("is-scaffold");
  });

  it("renders expandable detail when the row is selected", () => {
    const html = renderToStaticMarkup(
      <SpanRow
        node={span({
          id: "tool",
          type: "TOOL_CALL",
          category: "tool_call",
          attemptIndex: 1,
          timestamp: "2026-08-28T04:00:00.000Z",
          metadata: { command: "npm test", exitCode: 1 },
        })}
        depth={1}
        expanded={new Set(["tool"])}
        onToggle={() => undefined}
        failingEventId={null}
        selected="tool"
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain('class="span-detail"');
    expect(html).toContain("padding-left:36px");
    expect(html).toContain("<dt>category</dt>");
    expect(html).toContain("<dd>tool_call</dd>");
    expect(html).toContain("<dt>attempt</dt>");
    expect(html).toContain("<dd>1</dd>");
    expect(html).toContain("<dt>started</dt>");
    expect(html).toContain("<dd>2026-08-28T04:00:00.000Z</dd>");
    expect(html).toContain("<dt>command</dt>");
    expect(html).toContain("<dd>npm test</dd>");
    expect(html).toContain("<dt>exitCode</dt>");
    expect(html).toContain("<dd>1</dd>");
    expect(html).toContain('class="span-type"');
    expect(html).toMatch(/<button[^>]*class="span-type"/);
  });

  it("hides span detail when a different row is selected", () => {
    const html = renderToStaticMarkup(
      <SpanRow
        node={span({ id: "root", type: "TURN" })}
        depth={0}
        expanded={new Set(["root"])}
        onToggle={() => undefined}
        failingEventId={null}
        selected="other"
        onSelect={() => undefined}
      />,
    );

    expect(html).not.toContain('class="span-detail"');
  });
});

describe("buildActiveFilter", () => {
  it("returns undefined when every chip group is inactive", () => {
    expect(buildActiveFilter(false, null, null)).toBeUndefined();
  });

  it("omits inactive keys instead of passing empty arrays", () => {
    expect(buildActiveFilter(true, null, null)).toEqual({ status: ["error"] });
    expect(buildActiveFilter(false, "tool_call", null)).toEqual({
      category: ["tool_call"],
    });
    expect(buildActiveFilter(false, null, "human")).toEqual({ actor: ["human"] });
    expect(buildActiveFilter(true, "model_call", "agent")).toEqual({
      status: ["error"],
      category: ["model_call"],
      actor: ["agent"],
    });

    const serialized = JSON.stringify(buildActiveFilter(true, null, "middleware"));
    expect(serialized).not.toContain("[]");
  });
});
