import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  ContainerCodexRunner,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});

describe("container kill", () => {
  it("removes the container without marking the run cancelled", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: "/tmp/agentguard-kill/data",
      AGENT_WORKSPACE_ROOT: "/tmp/agentguard-kill/workspaces",
      CODEX_HOME: "/tmp/agentguard-kill/codex",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      // A binary that does not exist, so removeContainer takes its catch path
      // and falls back to child.kill() without needing a container engine.
      CONTAINER_ENGINE: "agentguard-no-such-engine",
    });
    const runner = new ContainerCodexRunner(config);

    const active = {
      child: { kill: () => undefined } as unknown as ChildProcess,
      containerName: "launchpad-test-agent-1",
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled: Promise.resolve(),
      termination: null,
    };
    (runner as unknown as { active: Map<string, typeof active> }).active.set("agent-1", active);

    const killed = await runner.kill("agent-1");
    expect(killed).toBe(true);
    expect(active.cancelled).toBe(false);
  });

  it("returns false for an unknown agent", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: "/tmp/agentguard-kill/data",
      AGENT_WORKSPACE_ROOT: "/tmp/agentguard-kill/workspaces",
      CODEX_HOME: "/tmp/agentguard-kill/codex",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    expect(await new ContainerCodexRunner(config).kill("nope")).toBe(false);
  });
});
