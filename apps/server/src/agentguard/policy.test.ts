import { describe, expect, it } from "vitest";
import { classifyFailure, severityFor } from "./failure-detector.js";
import {
  MAX_TIMEOUT_RETRIES,
  selectStrategy,
  shouldAbortAfterAttempts,
} from "./policy.js";

describe("failure-detector", () => {
  it("prefers injected failure types", () => {
    expect(
      classifyFailure({ injected: "runtime_crash", timedOut: true }),
    ).toBe("runtime_crash");
  });

  it("classifies timeout and crash messages", () => {
    expect(classifyFailure({ timedOut: true })).toBe("tool_timeout");
    expect(classifyFailure({ message: "Codex timed out after 1000 ms" })).toBe(
      "tool_timeout",
    );
    expect(classifyFailure({ message: "Codex exited with code 137" })).toBe(
      "runtime_crash",
    );
    expect(classifyFailure({ message: "mystery" })).toBe("unknown");
  });

  it("assigns severities", () => {
    expect(severityFor("tool_timeout")).toBe("medium");
    expect(severityFor("runtime_crash")).toBe("high");
  });
});

describe("policy", () => {
  it("maps failure types to strategies", () => {
    expect(selectStrategy("tool_timeout")).toBe("retry");
    expect(selectStrategy("runtime_crash")).toBe("restart_resume");
    expect(selectStrategy("unknown")).toBe("abort");
  });

  it("enforces retry and restart limits", () => {
    expect(shouldAbortAfterAttempts("tool_timeout", MAX_TIMEOUT_RETRIES)).toBe(
      false,
    );
    expect(
      shouldAbortAfterAttempts("tool_timeout", MAX_TIMEOUT_RETRIES + 1),
    ).toBe(true);
    expect(shouldAbortAfterAttempts("runtime_crash", 0)).toBe(false);
    expect(shouldAbortAfterAttempts("runtime_crash", 1)).toBe(true);
    expect(shouldAbortAfterAttempts("unknown", 0)).toBe(true);
  });
});
