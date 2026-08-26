import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "./checkpoint.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("checkpoint", () => {
  it("creates and restores a workspace snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentguard-cp-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const dataDirectory = path.join(root, "data");
    await writeFile(
      path.join(await (async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(workspace, { recursive: true });
        return workspace;
      })(), "note.txt"),
      "hello",
      "utf8",
    );

    const checkpoint = await createWorkspaceCheckpoint({
      dataDirectory,
      runId: "run-1",
      agentId: "agent-1",
      workspacePath: workspace,
      codexThreadId: "thread-1",
      boundary: "after_tool_call",
    });
    expect(checkpoint.codexThreadId).toBe("thread-1");

    await writeFile(path.join(workspace, "note.txt"), "changed", "utf8");
    await restoreWorkspaceCheckpoint({ workspacePath: workspace, checkpoint });
    expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("hello");
  });
});
