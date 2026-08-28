import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import type { ParsedEvents } from "./codex-runner.js";

function emptyParsedEvents(): ParsedEvents {
  return {
    messages: [],
    threadId: null,
    usage: null,
    errors: [],
    streamEvents: [],
  };
}

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
      streamEvents: [] as Array<{ type: string; status: string }>,
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(parsed.streamEvents[0]?.type).toBe("MODEL_CALL");
  });
});

describe("codex item extraction", () => {
  it("marks a non-zero command exit as an error span", () => {
    const parsed = emptyParsedEvents();
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          exit_code: 1,
          aggregated_output: "1 failing",
        },
      }),
      parsed,
    );
    const event = parsed.streamEvents[0];
    expect(event?.type).toBe("TOOL_CALL");
    expect(event?.status).toBe("error");
    expect(event?.metadata?.command).toBe("npm test");
    expect(event?.metadata?.exitCode).toBe(1);
    expect(event?.error).toContain("1");
  });

  it("marks a zero command exit as ok", () => {
    const parsed = emptyParsedEvents();
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls", exit_code: 0 },
      }),
      parsed,
    );
    expect(parsed.streamEvents[0]?.status).toBe("ok");
  });

  it("extracts changed paths from a file change item", () => {
    const parsed = emptyParsedEvents();
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "modify" }] },
      }),
      parsed,
    );
    expect(parsed.streamEvents[0]?.metadata?.paths).toEqual(["src/a.ts"]);
    expect(parsed.streamEvents[0]?.metadata?.count).toBe(1);
  });

  it("flags unrecognized item types instead of disguising them", () => {
    const parsed = emptyParsedEvents();
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "future_thing" } }),
      parsed,
    );
    expect(parsed.streamEvents[0]?.metadata?.unrecognized).toBe(true);
    expect(parsed.streamEvents[0]?.metadata?.rawType).toBe("future_thing");
  });

  it("stamps observedAt on every stream event", () => {
    const parsed = emptyParsedEvents();
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
      parsed,
    );
    expect(typeof parsed.streamEvents[0]?.observedAt).toBe("number");
  });
});
