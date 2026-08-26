import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { RunCancelledError } from "../errors.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "agentguard-svc-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("AgentGuard integration", () => {
  it("records a successful run timeline without incidents", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "MODEL_CALL",
          status: "ok",
          metadata: { note: "safe" },
        });
        return {
          output: "ok",
          threadId: "thread-ok",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guard" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const events = service.getEvents(run.id);
    expect(events.some((event) => event.type === "RUN_STARTED")).toBe(true);
    expect(events.some((event) => event.type === "MODEL_CALL")).toBe(true);
    expect(events.some((event) => event.type === "CHECKPOINT_CREATED")).toBe(true);
    expect(events.some((event) => event.type === "RUN_COMPLETED")).toBe(true);
    expect(service.getIncidents(run.id)).toHaveLength(0);
    expect(service.getRun(run.id).usage?.inputTokens).toBe(3);
  });

  it("recovers from an injected runtime crash using a checkpoint", async () => {
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    const firstHang = new Promise<RunnerResult>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        calls += 1;
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: { step: calls },
        });
        if (calls === 1) {
          return firstHang;
        }
        return {
          output: "recovered",
          threadId: request.threadId ?? "thread-2",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      cancel: async () => {
        rejectFirst(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Crashy" });
    await writeFile(path.join(agent.workspacePath, "work.txt"), "before", "utf8");
    const { run } = await service.sendMessage(agent.id, "do work");
    await expect.poll(() => service.getEvents(run.id).some((e) => e.type === "CHECKPOINT_CREATED"))
      .toBe(true);
    await service.injectFailure(run.id, "runtime_crash");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const types = service.getEvents(run.id).map((event) => event.type);
    expect(types).toContain("INCIDENT_OPENED");
    expect(types).toContain("RECOVERY_STARTED");
    expect(types).toContain("RECOVERY_VERIFIED");
    expect(service.getRecoveries(run.id)[0]?.strategy).toBe("restart_resume");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("retries timeouts then aborts with an alert", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        calls += 1;
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: { attempt: calls },
        });
        throw new Error("Codex timed out after 1000 ms");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Timeout" });
    const { run } = await service.sendMessage(agent.id, "slow tool");
    await expect
      .poll(() => service.getRun(run.id).status, { timeout: 10_000 })
      .toBe("failed");
    expect(service.getEvents(run.id).some((event) => event.type === "ALERT")).toBe(true);
    expect(service.getIncidents(run.id).some((item) => item.status === "aborted")).toBe(
      true,
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("redacts secrets from stored events", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "MODEL_CALL",
          status: "ok",
          metadata: {
            ARK_API_KEY: "super-secret",
            note: "Bearer tokensecretvalue",
          },
        });
        return { output: "done", threadId: "t1", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Redact" });
    const { run } = await service.sendMessage(agent.id, "secret");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const modelEvent = service
      .getEvents(run.id)
      .find((event) => event.type === "MODEL_CALL" && event.metadata.ARK_API_KEY);
    expect(modelEvent?.metadata.ARK_API_KEY).toBe("[REDACTED]");
    expect(JSON.stringify(modelEvent?.metadata)).not.toContain("super-secret");
    expect(JSON.stringify(modelEvent?.metadata)).not.toContain("tokensecretvalue");
  });
});

describe("AgentGuard fixtures", () => {
  it("ships golden sequences", async () => {
    const { readFile } = await import("node:fs/promises");
    const fixturesRoot = path.resolve(
      process.cwd(),
      "fixtures/agentguard",
    );
    const crash = JSON.parse(
      await readFile(path.join(fixturesRoot, "crash-then-recover.json"), "utf8"),
    ) as { events: string[] };
    const secrets = JSON.parse(
      await readFile(path.join(fixturesRoot, "secrets-redacted.json"), "utf8"),
    ) as { forbidden: string[] };
    expect(crash.events).toContain("RECOVERY_VERIFIED");
    expect(secrets.forbidden.length).toBeGreaterThan(0);
  });
});
