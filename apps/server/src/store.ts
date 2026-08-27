import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRun, Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
  events: [],
  incidents: [],
  recoveryAttempts: [],
  diagnoses: [],
  checkpoints: [],
  agentGuardSettings: null,
});

function migrateDatabase(raw: unknown): Database {
  const parsed = raw as Partial<Database> & { version?: number; runs?: AgentRun[] };
  if (!Array.isArray(parsed.agents)) {
    throw new Error("Unsupported database format");
  }
  const runs = (parsed.runs ?? []).map((run) => ({
    ...run,
    recoveryAttemptCount:
      typeof run.recoveryAttemptCount === "number" ? run.recoveryAttemptCount : 0,
    tokensUsed: typeof run.tokensUsed === "number" ? run.tokensUsed : 0,
    tokenBudget:
      typeof run.tokenBudget === "number" ? run.tokenBudget : 50_000,
    pendingApprovalIncidentId:
      run.pendingApprovalIncidentId === undefined
        ? null
        : run.pendingApprovalIncidentId,
  }));
  return {
    version: 3,
    agents: parsed.agents,
    messages: parsed.messages ?? [],
    runs,
    events: parsed.events ?? [],
    incidents: parsed.incidents ?? [],
    recoveryAttempts: parsed.recoveryAttempts ?? [],
    diagnoses: parsed.diagnoses ?? [],
    checkpoints: parsed.checkpoints ?? [],
    agentGuardSettings:
      parsed.agentGuardSettings && typeof parsed.agentGuardSettings === "object"
        ? parsed.agentGuardSettings
        : null,
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = migrateDatabase(JSON.parse(raw));
      if ((JSON.parse(raw) as { version?: number }).version !== 3) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
