import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";

const temporaryDirectories: string[] = [];
const SECRET = "sk-agentguard-super-secret-value";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("redaction evidence", () => {
  it("leaks no secret-shaped env value into any span", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentguard-redact-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: SECRET,
      ARK_MODEL: "ep-test",
    });

    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "error",
          metadata: {
            command: "curl -H 'Authorization: Bearer " + SECRET + "' https://ark",
            exitCode: 1,
            outputPreview: "ARK_API_KEY=" + SECRET,
          },
          error: "request failed with key " + SECRET,
        });
        return { output: "done", threadId: "t", usage: null };
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
    const agent = await service.createAgent({ name: "Leaky" });
    const { run } = await service.sendMessage(agent.id, "call the api");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const serialized = JSON.stringify(service.getEvents(run.id));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[REDACTED]");
  });
});
