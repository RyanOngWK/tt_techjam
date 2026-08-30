import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryDirectories } from "../test/settle.js";
import { JsonStore } from "../store.js";
import { appendTraceEvent, endSpan, eventsForRun, startSpan } from "./trace-collector.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await removeTemporaryDirectories(temporaryDirectories);
});

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "agentguard-tc-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

describe("trace collector", () => {
  it("defaults category and actor from the event type", async () => {
    const store = await makeStore();
    const event = await appendTraceEvent(store, {
      runId: "run-1",
      type: "TOOL_CALL",
      status: "ok",
    });
    expect(event.category).toBe("tool_call");
    expect(event.actor).toBe("agent");
    expect(event.attemptIndex).toBe(0);
    expect(event.durationMs).toBeNull();
    expect(event.durationSource).toBeNull();
    expect(event.endedAt).toBeNull();
  });

  it("allows an explicit actor override", async () => {
    const store = await makeStore();
    const event = await appendTraceEvent(store, {
      runId: "run-1",
      type: "TOOL_CALL",
      status: "ok",
      actor: "middleware",
    });
    expect(event.actor).toBe("middleware");
  });

  it("opens a span as running and closes it with a measured duration", async () => {
    const store = await makeStore();
    const spanId = await startSpan(store, {
      runId: "run-1",
      type: "TURN",
      attemptIndex: 2,
      metadata: { tier: "normal" },
    });

    const opened = eventsForRun(store, "run-1")[0];
    expect(opened?.status).toBe("running");
    expect(opened?.attemptIndex).toBe(2);

    await endSpan(store, spanId, { status: "ok", metadata: { usage: 12 } });

    const closed = eventsForRun(store, "run-1")[0];
    expect(closed?.status).toBe("ok");
    expect(closed?.endedAt).not.toBeNull();
    expect(closed?.durationMs).toBeGreaterThanOrEqual(0);
    expect(closed?.durationSource).toBe("measured");
    expect(closed?.metadata.tier).toBe("normal");
    expect(closed?.metadata.usage).toBe(12);
  });

  it("records a supplied duration source and redacts errors on close", async () => {
    const store = await makeStore();
    const spanId = await startSpan(store, { runId: "run-1", type: "TOOL_CALL" });
    await endSpan(store, spanId, {
      status: "error",
      error: "failed with ARK_API_KEY=sk-secret-value",
      durationSource: "inter_item_delta",
    });
    const closed = eventsForRun(store, "run-1")[0];
    expect(closed?.durationSource).toBe("inter_item_delta");
    expect(closed?.error).not.toContain("sk-secret-value");
  });

  it("ignores endSpan for an unknown span id", async () => {
    const store = await makeStore();
    await expect(endSpan(store, "missing", { status: "ok" })).resolves.toBeUndefined();
  });
});
