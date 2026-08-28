import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { FastifyInstance } from "fastify";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeApp(): Promise<{ app: FastifyInstance; service: AgentService }> {
  const root = await mkdtemp(path.join(tmpdir(), "agentguard-app-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const runner: AgentRunner = {
    async run(request: RunnerRequest): Promise<RunnerResult> {
      await request.onEvent?.({
        type: "MODEL_CALL",
        status: "ok",
        metadata: { note: "ok" },
      });
      return { output: "ok", threadId: "t", usage: null };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  const app = await createApp(config, service);
  apps.push(app);
  return { app, service };
}

describe("trace query API", () => {
  it("lists runs newest first with summary counts", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "Listed" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { runs: Array<Record<string, unknown>> };
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs[0]).toHaveProperty("spanCount");
    expect(body.runs[0]).toHaveProperty("errorCount");
    expect(body.runs[0]).toHaveProperty("agentName");
  });

  it("returns a nested tree when tree=true", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "Treed" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?tree=true",
    });
    const body = response.json() as {
      events: Array<{ children: unknown[]; matched: boolean }>;
    };
    expect(body.events[0]).toHaveProperty("children");
    expect(body.events[0]?.matched).toBe(true);
  });

  it("filters spans by status", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "Filtered" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?status=error",
    });
    const body = response.json() as { events: unknown[] };
    expect(body.events).toEqual([]);
  });
});
