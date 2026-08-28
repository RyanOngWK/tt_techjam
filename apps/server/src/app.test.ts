import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryDirectories } from "./test/settle.js";
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
  await removeTemporaryDirectories(temporaryDirectories);
});

async function makeApp(runnerOverride?: AgentRunner): Promise<{ app: FastifyInstance; service: AgentService }> {
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
  const runner: AgentRunner = runnerOverride ?? {
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

  it("returns 404 for an unknown run on tree and flat event queries", async () => {
    const { app } = await makeApp();
    const missingId = crypto.randomUUID();

    const tree = await app.inject({
      method: "GET",
      url: "/api/runs/" + missingId + "/events?tree=true",
    });
    expect(tree.statusCode).toBe(404);

    const flat = await app.inject({
      method: "GET",
      url: "/api/runs/" + missingId + "/events",
    });
    expect(flat.statusCode).toBe(404);
  });

  it("keeps failing spans nested under dimmed ancestors when tree=true filters", async () => {
    const { app, service } = await makeApp({
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "error",
          metadata: { command: "false", exitCode: 1 },
          error: "Runtime exited with code 1",
        });
        return { output: "done", threadId: "t-err", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "FilterTree" });
    const { run } = await service.sendMessage(agent.id, "boom");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?tree=true&status=error",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: Array<{
        type: string;
        matched: boolean;
        status: string;
        children: Array<{ type: string; matched: boolean }>;
      }>;
    };
    expect(body.events).toHaveLength(1);
    const root = body.events[0]!;
    expect(root.type).toBe("RUN_STARTED");
    expect(root.matched).toBe(false);
    const turn = root.children[0]!;
    expect(turn.matched).toBe(false);
    const tool = turn.children.find((child) => child.status === "error");
    expect(tool).toBeDefined();
    expect(tool?.matched).toBe(true);
  });

  it("exports redacted events with a download disposition", async () => {
    const secret = "ark_export_evidence_key_2026";
    const { app, service } = await makeApp({
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "error",
          metadata: {
            command: "printenv ARK_API_KEY",
            outputPreview: "ARK_API_KEY=" + secret,
          },
          error: "request failed: ARK_API_KEY=" + secret,
        });
        return { output: "done", threadId: "t-export", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Exporter" });
    const { run } = await service.sendMessage(agent.id, "export me");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?format=download",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    const raw = response.body;
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    const parsed = response.json() as { runId: string; events: unknown[] };
    expect(parsed.runId).toBe(run.id);
    expect(parsed.events.length).toBeGreaterThan(0);
  });

  it("sends a download disposition for format=json", async () => {
    const { app, service } = await makeApp();
    const agent = await service.createAgent({ name: "JsonExport" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + run.id + "/events?format=json",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
  });
});
