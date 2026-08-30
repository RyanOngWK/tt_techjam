import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryDirectories } from "./test/settle.js";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await removeTemporaryDirectories(temporaryDirectories);
});

function makeManager(): { root: string; manager: WorkspaceManager } {
  const root = path.join(tmpdir(), "launchpad-workspace-test-");
  const rootWithPid = root + "-" + process.pid + "-" + temporaryDirectories.length;
  temporaryDirectories.push(rootWithPid);
  return { root: rootWithPid, manager: new WorkspaceManager(rootWithPid) };
}

function makeAgent(root: string): Agent {
  return {
    id: "workspace-test-agent",
    name: "Builder",
    description: "Builds apps",
    instructions: "Build what the user asks for.",
    status: "ready",
    workspacePath: path.join(root, "workspace-test-agent"),
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("WorkspaceManager LLM Wiki scaffolding", () => {
  it("writes the LLM Wiki section into the generated AGENTS.md", async () => {
    const { root, manager } = makeManager();
    await manager.initialize();
    const agent = makeAgent(root);
    await manager.create(agent);

    const agentsMd = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## LLM Wiki");
    expect(agentsMd).toContain("create and maintain an\nLLM wiki at `wiki/` to manage the code");
    expect(agentsMd).toContain("Deem a task large when it spans multiple components or files");
    expect(agentsMd).toContain("`@wikier` subagent");
    expect(agentsMd).toContain(
      "`## [YYYY-MM-DD] operation | Title`",
    );
  });

  it("writes a Codex custom-agent file for the wikier subagent", async () => {
    const { root, manager } = makeManager();
    await manager.initialize();
    const agent = makeAgent(root);
    await manager.create(agent);

    const toml = await readFile(
      path.join(agent.workspacePath, ".codex", "agents", "wikier.toml"),
      "utf8",
    );
    expect(toml).toContain('name = "wikier"');
    expect(toml).toContain("description =");
    expect(toml).toContain('developer_instructions = """');
    expect(toml).toContain("wiki/index.md");
    expect(toml).toContain("wiki/log.md");
    expect(toml).toContain("Never put credentials or secrets in the wiki.");
  });

  it("refreshes the wiki instructions and wikier agent on update", async () => {
    const { root, manager } = makeManager();
    await manager.initialize();
    const agent = makeAgent(root);
    await manager.create(agent);

    const updated = { ...agent, name: "Renamed" };
    await manager.writeInstructions(updated);

    const agentsMd = await readFile(path.join(updated.workspacePath, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("You are the coding Agent named Renamed.");
    expect(agentsMd).toContain("## LLM Wiki");

    const toml = await readFile(
      path.join(updated.workspacePath, ".codex", "agents", "wikier.toml"),
      "utf8",
    );
    expect(toml).toContain('name = "wikier"');
  });
});
