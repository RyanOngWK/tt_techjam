import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { parseCodexEventLine, type ParsedEvents } from "../codex-runner.js";
import { RunCancelledError } from "../errors.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { buildSpanTree } from "./span-tree.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner,
  envOverrides: Record<string, string> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "agentguard-svc-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...envOverrides,
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

  it("issues a diagnosis that progresses through the crash-recovery lifecycle", async () => {
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
    const agent = await service.createAgent({ name: "Diagnosed" });
    await writeFile(path.join(agent.workspacePath, "work.txt"), "before", "utf8");
    const { run } = await service.sendMessage(agent.id, "do work");
    await expect
      .poll(() => service.getEvents(run.id).some((e) => e.type === "CHECKPOINT_CREATED"))
      .toBe(true);
    await service.injectFailure(run.id, "runtime_crash");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect.poll(() => service.getDiagnoses(run.id).length).toBe(1);
    const diagnosis = service.getDiagnoses(run.id)[0];
    expect(diagnosis.failureType).toBe("runtime_crash");
    expect(diagnosis.severity).toBe("high");
    expect(diagnosis.strategy).toBe("restart_resume");
    expect(diagnosis.strategyRationale).toBeTruthy();
    expect(diagnosis.evidence.length).toBeGreaterThan(0);
    expect(diagnosis.rootCause).toBeTruthy();
    expect(diagnosis.confidence).toBeGreaterThan(0);

    await expect.poll(() => service.getDiagnoses(run.id)[0]?.status).toBe("verified");
    const finalDiagnosis = service.getDiagnoses(run.id)[0];
    expect(finalDiagnosis.stateDelta).not.toBeNull();
    expect(finalDiagnosis.stateDelta?.checkpointId).toBeTruthy();
    expect(finalDiagnosis.stateDelta?.workspaceFiles).toBeGreaterThanOrEqual(1);
    expect(typeof finalDiagnosis.stateDelta?.codexThreadReattached).toBe("boolean");
    expect(
      service.getEvents(run.id).some((event) => event.type === "DIAGNOSIS_ISSUED"),
    ).toBe(true);
    expect(
      service.getEvents(run.id).some((event) => event.type === "DIAGNOSIS_VERDICT"),
    ).toBe(true);
  });

  it("marks a diagnosis aborted when retries are exhausted", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: { note: "x" },
        });
        throw new Error("Codex timed out after 1000 ms");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "DiagTimeout" });
    const { run } = await service.sendMessage(agent.id, "slow tool");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect.poll(() => service.getDiagnoses(run.id)[0]?.status).toBe("aborted");
    expect(service.getDiagnoses(run.id)[0]?.failureType).toBe("tool_timeout");
    expect(service.getDiagnoses(run.id).length).toBeGreaterThanOrEqual(1);
  });

  it("flags a diagnosis as awaiting approval on budget HITL and verifies after approve", async () => {
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
          output: "after-budget",
          threadId: request.threadId ?? "thread-budget",
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
    const agent = await service.createAgent({ name: "DiagBudget" });
    const { run } = await service.sendMessage(agent.id, "spend");
    await expect
      .poll(() => service.getEvents(run.id).some((e) => e.type === "CHECKPOINT_CREATED"))
      .toBe(true);
    await service.injectFailure(run.id, "budget_exceeded");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    await expect.poll(() => service.getDiagnoses(run.id)[0]?.status).toBe(
      "awaiting_approval",
    );
    expect(service.getDiagnoses(run.id)[0]?.failureType).toBe("budget_exceeded");
    await service.resolveApproval(run.id, "approve");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect.poll(() => service.getDiagnoses(run.id)[0]?.status).toBe("verified");
  });

  it("warns which config field is too short to redact without echoing its value", async () => {
    const runner: AgentRunner = {
      async run(): Promise<RunnerResult> {
        return { output: "done", threadId: "t-warn", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      await makeService(runner, { APP_AUTH_TOKEN: "zqx9j" });
    } finally {
      warnSpy.mockRestore();
    }

    const text = warnings.join("\n");
    expect(text).toContain("authToken");
    expect(text).not.toContain("zqx");
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
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: {
            itemType: "command_execution",
            command: "printenv",
            outputPreview: "Bearer tokensecretvalue",
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
    const events = service.getEvents(run.id);
    const modelEvent = events.find(
      (event) => event.type === "MODEL_CALL" && event.metadata.ARK_API_KEY,
    );
    expect(modelEvent?.metadata.ARK_API_KEY).toBe("[REDACTED]");
    expect(JSON.stringify(modelEvent?.metadata)).not.toContain("super-secret");
    expect(JSON.stringify(modelEvent?.metadata)).not.toContain("tokensecretvalue");

    const commandEvent = events.find(
      (event) => event.metadata.itemType === "command_execution",
    );
    expect(commandEvent).toBeDefined();
    expect(String(commandEvent?.metadata.outputPreview)).toContain("[REDACTED]");
  });

  it("redacts a bare configured Ark API key from command output before persistence", async () => {
    const secret = "ark_live_A8+meta.chars/2026_secret";
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        const parsed: ParsedEvents = {
          messages: [],
          threadId: null,
          usage: null,
          errors: [],
          streamEvents: [],
        };
        parseCodexEventLine(
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "printenv ARK_API_KEY",
              aggregated_output: secret,
              exit_code: 0,
            },
          }),
          parsed,
        );
        for (const event of parsed.streamEvents) {
          await request.onEvent?.(event);
        }
        return { output: "done", threadId: "t-secret", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { ARK_API_KEY: secret });
    const agent = await service.createAgent({ name: "BareSecret" });
    const { run } = await service.sendMessage(agent.id, "show environment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const serializedEvents = JSON.stringify(service.getEvents(run.id));
    expect(serializedEvents).not.toContain(secret);
    expect(serializedEvents).toContain("[REDACTED]");
  });

  it("leaves no recoverable fragment of a secret that straddles the preview boundary", async () => {
    const secret = "boundaryLeakCanary_0123456789_abcdefghijk";
    // Truncating first would keep exactly the first 30 characters of the secret,
    // which literal value matching can no longer recognize afterwards.
    const fragment = secret.slice(0, 30);
    const output = "o".repeat(170) + secret;
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        const parsed: ParsedEvents = {
          messages: [],
          threadId: null,
          usage: null,
          errors: [],
          streamEvents: [],
        };
        parseCodexEventLine(
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "printenv ARK_API_KEY",
              aggregated_output: output,
              exit_code: 0,
            },
          }),
          parsed,
        );
        for (const event of parsed.streamEvents) {
          await request.onEvent?.(event);
        }
        return { output: "done", threadId: "t-boundary", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { ARK_API_KEY: secret });
    const agent = await service.createAgent({ name: "BoundarySecret" });
    const { run } = await service.sendMessage(agent.id, "show environment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const commandEvent = service
      .getEvents(run.id)
      .find((event) => event.metadata.itemType === "command_execution");
    expect(commandEvent).toBeDefined();
    const outputPreview = String(commandEvent?.metadata.outputPreview);
    expect(outputPreview).toContain("[REDACTED]");
    expect(outputPreview.length).toBeLessThanOrEqual(200);
    expect(outputPreview).not.toContain(fragment);

    const serializedEvents = JSON.stringify(service.getEvents(run.id));
    expect(serializedEvents).not.toContain(fragment);
    expect(serializedEvents).not.toContain(secret);
  });

  it("restores the latest checkpoint on timeout retry", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        calls += 1;
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: { attempt: calls },
        });
        if (calls === 1) {
          await writeFile(
            path.join(request.workspacePath, "work.txt"),
            "dirty",
            "utf8",
          );
          throw new Error("Codex timed out after 1000 ms");
        }
        return {
          output: "retried",
          threadId: request.threadId ?? "thread-retry",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "RetryCkpt" });
    await writeFile(path.join(agent.workspacePath, "work.txt"), "clean", "utf8");
    const { run } = await service.sendMessage(agent.id, "retry me");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(agent.workspacePath, "work.txt"), "utf8")).toBe(
      "clean",
    );
    expect(service.getRecoveries(run.id)[0]?.strategy).toBe("retry");
    const started = service
      .getEvents(run.id)
      .find((event) => event.type === "RECOVERY_STARTED");
    expect(started?.metadata.retryOf).toBeTruthy();
    expect(started?.metadata.checkpointId).toBeTruthy();
  });

  it("pauses for approval on budget exceed and resumes after approve", async () => {
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
          output: "after-budget",
          threadId: request.threadId ?? "thread-budget",
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
    const agent = await service.createAgent({ name: "Budget" });
    const { run } = await service.sendMessage(agent.id, "spend");
    await expect
      .poll(() => service.getEvents(run.id).some((e) => e.type === "CHECKPOINT_CREATED"))
      .toBe(true);
    await service.injectFailure(run.id, "budget_exceeded");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    await service.resolveApproval(run.id, "approve");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getEvents(run.id).some((e) => e.type === "BUDGET_RAISED")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    const roots = buildSpanTree(service.getEvents(run.id));
    expect(roots).toHaveLength(1);
    expect(roots[0]?.type).toBe("RUN_STARTED");
  });

  it("auto-compresses on projected budget exceed without HITL", async () => {
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    let secondPrompt = "";
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
        secondPrompt = request.prompt;
        return {
          output: "compressed-ok",
          threadId: request.threadId ?? "thread-compress",
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
    const agent = await service.createAgent({ name: "Compress" });
    const { run } = await service.sendMessage(agent.id, "stay under budget");
    await expect
      .poll(() => service.getEvents(run.id).some((e) => e.type === "CHECKPOINT_CREATED"))
      .toBe(true);
    await service.injectFailure(run.id, "budget_projected_exceeded");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).status).not.toBe("awaiting_approval");
    expect(service.getEvents(run.id).some((e) => e.type === "BUDGET_COMPRESSED")).toBe(
      true,
    );
    expect(service.getRecoveries(run.id).some((r) => r.strategy === "compress_resume")).toBe(
      true,
    );
    expect(secondPrompt).toContain("[AgentGuard budget control]");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("applies patched token budget to new runs only", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        return {
          output: "ok",
          threadId: "thread-budget",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Budget" });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const originalBudget = service.getRun(first.run.id).tokenBudget;

    await service.updateAgentGuardSettings({ tokenBudget: 99_999 });
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    expect(service.getRun(first.run.id).tokenBudget).toBe(originalBudget);
    expect(service.getRun(second.run.id).tokenBudget).toBe(99_999);
  });

  it("emits a real turn span and never fabricates telemetry", async () => {
    const runner: AgentRunner = {
      async run(): Promise<RunnerResult> {
        return { output: "quiet", threadId: "thread-quiet", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Quiet" });
    const { run } = await service.sendMessage(agent.id, "say nothing");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const events = service.getEvents(run.id);
    const runStarted = events.find((event) => event.type === "RUN_STARTED");
    const turn = events.find((event) => event.type === "TURN");
    expect(turn).toBeDefined();
    expect(turn?.status).toBe("ok");
    expect(turn?.durationMs).toBeGreaterThanOrEqual(0);
    expect(turn?.durationSource).toBe("measured");
    expect(turn?.attemptIndex).toBe(0);
    expect(turn?.parentEventId).toBe(runStarted?.id);
    expect(events.some((event) => event.type === "MODEL_CALL")).toBe(false);
    expect(events.every((event) => event.metadata.synthesized === undefined)).toBe(true);
    expect(events.every((event) => event.category !== undefined)).toBe(true);
    expect(events.every((event) => event.actor !== undefined)).toBe(true);
  });

  it("leaves the first item duration unknown and derives later inter-item duration", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "MODEL_CALL",
          status: "ok",
          observedAt: 1_000,
        });
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          observedAt: 1_250,
        });
        return { output: "done", threadId: "t-duration", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Durations" });
    const { run } = await service.sendMessage(agent.id, "measure");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const itemEvents = service
      .getEvents(run.id)
      .filter((event) => event.type === "MODEL_CALL" || event.type === "TOOL_CALL");
    expect(itemEvents[0]?.durationMs).toBeNull();
    expect(itemEvents[0]?.durationSource).toBeNull();
    expect(itemEvents[1]?.durationMs).toBe(250);
    expect(itemEvents[1]?.durationSource).toBe("inter_item_delta");
  });

  it("excludes unrecognized items from the budget projection count", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "TOOL_CALL",
          status: "ok",
          metadata: {
            itemType: "future_thing",
            rawType: "future_thing",
            unrecognized: true,
          },
        });
        return { output: "done", threadId: "t-unrecognized", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, {
      AGENTGUARD_TOKEN_BUDGET: "500",
      AGENTGUARD_BUDGET_STRICT_RATIO: "0",
      AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE: "0",
      AGENTGUARD_BUDGET_EST_TOOL_TOKENS: "1000",
      AGENTGUARD_BUDGET_CHARS_PER_TOKEN: "1000000",
    });
    const agent = await service.createAgent({ name: "UnknownBudget" });
    const { run } = await service.sendMessage(agent.id, "future tool");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(
      service
        .getEvents(run.id)
        .some((event) => event.type === "BUDGET_PROJECTED_EXCEED"),
    ).toBe(false);
  });

  it("does not report a budget-cancelled turn as successful when the runner resolves", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({
          type: "MODEL_CALL",
          status: "ok",
          metadata: { note: "projected over budget" },
        });
        return { output: "late success", threadId: "thread-late", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, {
      AGENTGUARD_TOKEN_BUDGET: "100",
      AGENTGUARD_BUDGET_STRICT_RATIO: "0",
      AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE: "0",
    });
    const agent = await service.createAgent({ name: "NonAbortingCancel" });
    const { run } = await service.sendMessage(agent.id, "stay within budget");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const events = service.getEvents(run.id);
    expect(events.some((event) => event.type === "BUDGET_PROJECTED_EXCEED")).toBe(true);
    const turn = events.find((event) => event.type === "TURN");
    expect(turn?.status).toBe("error");
    expect(turn?.error).toBe(
      "Mid-turn budget cancellation was requested, but the runner completed regardless",
    );
  });

  it("nests incident and recovery spans under the failing span", async () => {
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
        if (calls === 1) return firstHang;
        return { output: "recovered", threadId: "thread-2", usage: null };
      },
      cancel: async () => {
        rejectFirst(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Nested" });
    const { run } = await service.sendMessage(agent.id, "do work");
    await expect
      .poll(() =>
        service.getEvents(run.id).some((event) => event.type === "CHECKPOINT_CREATED"),
      )
      .toBe(true);
    await service.injectFailure(run.id, "runtime_crash");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const events = service.getEvents(run.id);
    const incident = events.find((event) => event.type === "INCIDENT_OPENED");
    expect(incident?.parentEventId).not.toBeNull();

    const failingId = incident!.parentEventId!;
    const nested = events.filter((event) => event.parentEventId === failingId);
    expect(nested.some((event) => event.type === "INCIDENT_OPENED")).toBe(true);
    expect(nested.some((event) => event.type === "DIAGNOSIS_ISSUED")).toBe(true);
    expect(nested.some((event) => event.type === "RECOVERY_STARTED")).toBe(true);
    expect(nested.some((event) => event.type === "RECOVERY_COMPLETED")).toBe(true);

    const error = events.find((event) => event.id === failingId);
    const failedTurn = events.find((event) => event.id === error?.parentEventId);
    expect(error?.type).toBe("ERROR");
    expect(failedTurn?.type).toBe("TURN");
    expect(failedTurn?.status).toBe("error");

    const recoveredTurn = events.find(
      (event) => event.type === "TURN" && event.attemptIndex === 1,
    );
    const verified = events.find((event) => event.type === "RECOVERY_VERIFIED");
    expect(recoveredTurn).toBeDefined();
    expect(verified?.parentEventId).toBe(recoveredTurn?.id);

    const roots = buildSpanTree(events);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.type).toBe("RUN_STARTED");
  });

  it("parents a post-recovery budget error to the recovered turn", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async run(): Promise<RunnerResult> {
        calls += 1;
        if (calls === 1) throw new Error("runtime crash");
        return {
          output: "recovered over budget",
          threadId: "thread-recovered-budget",
          usage: { inputTokens: 6, outputTokens: 5 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, {
      AGENTGUARD_TOKEN_BUDGET: "10",
      AGENTGUARD_BUDGET_NEXT_TURN_ESTIMATE: "0",
    });
    const agent = await service.createAgent({ name: "RecoveredBudget" });
    const { run } = await service.sendMessage(agent.id, "recover then exceed budget");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");

    const events = service.getEvents(run.id);
    const errors = events.filter((event) => event.type === "ERROR");
    const recoveredTurn = events.find(
      (event) => event.type === "TURN" && event.attemptIndex === 1,
    );
    expect(errors).toHaveLength(2);
    expect(recoveredTurn).toBeDefined();
    expect(errors[1]?.parentEventId).toBe(recoveredTurn?.id);

    await service.resolveApproval(run.id, "approve");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("produces an acyclic tree rooted at the run span", async () => {
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await request.onEvent?.({ type: "MODEL_CALL", status: "ok" });
        return { output: "ok", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Tree" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const roots = buildSpanTree(service.getEvents(run.id));
    expect(roots).toHaveLength(1);
    expect(roots[0]?.type).toBe("RUN_STARTED");
  });
});

describe("AgentGuard fixtures", () => {
  it("ships golden sequences", async () => {
    const { readFile } = await import("node:fs/promises");
    const fixturesRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../fixtures/agentguard",
    );
    const crash = JSON.parse(
      await readFile(path.join(fixturesRoot, "crash-then-recover.json"), "utf8"),
    ) as { events: string[] };
    const secrets = JSON.parse(
      await readFile(path.join(fixturesRoot, "secrets-redacted.json"), "utf8"),
    ) as { forbidden: string[] };
    expect(crash.events).toContain("RECOVERY_VERIFIED");
    expect(secrets.forbidden.length).toBeGreaterThan(0);
    const soft = JSON.parse(
      await readFile(path.join(fixturesRoot, "budget-soft-compress.json"), "utf8"),
    ) as { events: string[] };
    const hard = JSON.parse(
      await readFile(path.join(fixturesRoot, "budget-hard-hitl.json"), "utf8"),
    ) as { events: string[] };
    expect(soft.events).toContain("BUDGET_COMPRESSED");
    expect(hard.events).toContain("BUDGET_RAISED");
  });
});
