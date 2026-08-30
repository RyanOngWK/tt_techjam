import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Checkpoint } from "../types.js";

const MAX_CHECKPOINTS_PER_RUN = 5;

/** Volatile or regenerable paths — copying these races with npm/Codex and can crash fs.cp. */
const CHECKPOINT_SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  ".turbo",
]);

export function shouldIncludeInCheckpointSnapshot(
  workspaceRoot: string,
  entryPath: string,
): boolean {
  const relative = path.relative(workspaceRoot, entryPath);
  if (!relative || relative.startsWith("..")) {
    return true;
  }
  for (const segment of relative.split(path.sep)) {
    if (CHECKPOINT_SKIP_SEGMENTS.has(segment)) {
      return false;
    }
  }
  return true;
}

function checkpointCopyFilter(workspaceRoot: string) {
  return (source: string) => shouldIncludeInCheckpointSnapshot(workspaceRoot, source);
}

export function checkpointRoot(dataDirectory: string): string {
  return path.join(dataDirectory, "checkpoints");
}

export async function createWorkspaceCheckpoint(input: {
  dataDirectory: string;
  runId: string;
  agentId: string;
  workspacePath: string;
  codexThreadId: string | null;
  boundary: string;
}): Promise<Checkpoint> {
  const id = randomUUID();
  const snapshotRef = path.join(
    checkpointRoot(input.dataDirectory),
    input.runId,
    id,
  );
  await mkdir(path.dirname(snapshotRef), { recursive: true });
  await cp(input.workspacePath, snapshotRef, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: checkpointCopyFilter(input.workspacePath),
  });
  return {
    id,
    runId: input.runId,
    agentId: input.agentId,
    codexThreadId: input.codexThreadId,
    workspaceSnapshotRef: snapshotRef,
    boundary: input.boundary,
    createdAt: new Date().toISOString(),
  };
}

export async function restoreWorkspaceCheckpoint(input: {
  workspacePath: string;
  checkpoint: Checkpoint;
}): Promise<void> {
  await rm(input.workspacePath, { recursive: true, force: true });
  await mkdir(path.dirname(input.workspacePath), { recursive: true });
  await cp(input.checkpoint.workspaceSnapshotRef, input.workspacePath, {
    recursive: true,
    force: true,
    filter: checkpointCopyFilter(input.workspacePath),
  });
}

export async function pruneCheckpoints(
  checkpoints: Checkpoint[],
  runId: string,
): Promise<Checkpoint[]> {
  const forRun = checkpoints
    .filter((item) => item.runId === runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const keep = forRun.slice(0, MAX_CHECKPOINTS_PER_RUN);
  const drop = forRun.slice(MAX_CHECKPOINTS_PER_RUN);
  for (const item of drop) {
    await rm(item.workspaceSnapshotRef, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  const dropIds = new Set(drop.map((item) => item.id));
  return checkpoints.filter((item) => !dropIds.has(item.id));
}

export async function listSnapshotEntries(snapshotRef: string): Promise<string[]> {
  return readdir(snapshotRef);
}
