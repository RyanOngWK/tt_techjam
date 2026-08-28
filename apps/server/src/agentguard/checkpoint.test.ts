import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryDirectories } from "../test/settle.js";
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  shouldIncludeInCheckpointSnapshot,
} from "./checkpoint.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await removeTemporaryDirectories(temporaryDirectories);
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

  it("skips node_modules and other volatile directories in snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentguard-cp-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const dataDirectory = path.join(root, "data");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "note.txt"), "hello", "utf8");
    const nodeModules = path.join(workspace, "node_modules", "pkg");
    await mkdir(nodeModules, { recursive: true });
    await writeFile(path.join(nodeModules, "index.js"), "throw 1", "utf8");
    await writeFile(
      path.join(nodeModules, "broken.map"),
      "source",
      "utf8",
    );
    await rm(path.join(nodeModules, "broken.map"));
    await symlink("missing-target", path.join(nodeModules, "link.js"));

    expect(shouldIncludeInCheckpointSnapshot(workspace, workspace)).toBe(true);
    expect(shouldIncludeInCheckpointSnapshot(workspace, nodeModules)).toBe(false);

    const checkpoint = await createWorkspaceCheckpoint({
      dataDirectory,
      runId: "run-1",
      agentId: "agent-1",
      workspacePath: workspace,
      codexThreadId: "thread-1",
      boundary: "after_tool_call",
    });

    expect(
      await readFile(path.join(checkpoint.workspaceSnapshotRef, "note.txt"), "utf8"),
    ).toBe("hello");
    await expect(
      readFile(path.join(checkpoint.workspaceSnapshotRef, "node_modules", "pkg", "index.js")),
    ).rejects.toThrow();

    await writeFile(path.join(workspace, "note.txt"), "changed", "utf8");
    await restoreWorkspaceCheckpoint({ workspacePath: workspace, checkpoint });
    expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("hello");
  });
});
