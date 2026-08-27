import { describe, expect, it } from "vitest";
import {
  diagnoseFailure,
  signatureFor,
  summaryFor,
} from "./diagnostic.js";

describe("diagnoseFailure", () => {
  it("classifies an injected runtime crash with exit-code evidence", () => {
    const diagnosis = diagnoseFailure({
      injected: "runtime_crash",
      message: "Codex exited with code 137",
    });
    expect(diagnosis.failureType).toBe("runtime_crash");
    expect(diagnosis.severity).toBe("high");
    expect(diagnosis.confidence).toBe(1);
    expect(diagnosis.evidence.some((item) => item.signal === "injected_failure")).toBe(
      true,
    );
    expect(diagnosis.evidence.some((item) => item.signal === "exit_code")).toBe(true);
    expect(diagnosis.signature).toBe("runtime_crash:exit137");
    expect(diagnosis.rootCause).toContain("137");
    expect(diagnosis.rootCause).toContain("out-of-memory");
    expect(diagnosis.suggestions.some((item) => item.includes("CONTAINER_MEMORY_LIMIT"))).toBe(
      true,
    );
  });

  it("classifies a tool timeout and recommends a retry rationale", () => {
    const diagnosis = diagnoseFailure({ timedOut: true });
    expect(diagnosis.failureType).toBe("tool_timeout");
    expect(diagnosis.severity).toBe("medium");
    expect(diagnosis.confidence).toBe(0.9);
    expect(diagnosis.evidence.some((item) => item.signal === "runner_timeout")).toBe(true);
    expect(diagnosis.suggestions.some((item) => item.includes("CODEX_TIMEOUT_MS"))).toBe(true);
  });

  it("classifies budget signals from raw messages", () => {
    const exceeded = diagnoseFailure({
      message: "Token budget exceeded: 55000/50000",
      tokensUsed: 55_000,
      tokenBudget: 50_000,
    });
    expect(exceeded.failureType).toBe("budget_exceeded");
    expect(exceeded.evidence.some((item) => item.signal === "budget_usage")).toBe(true);

    const projected = diagnoseFailure({ budgetProjectedExceeded: true });
    expect(projected.failureType).toBe("budget_projected_exceeded");
    expect(projected.confidence).toBe(0.9);
  });

  it("keeps unknown failures low-confidence without guessing", () => {
    const diagnosis = diagnoseFailure({ message: "something mysterious" });
    expect(diagnosis.failureType).toBe("unknown");
    expect(diagnosis.confidence).toBe(0.4);
    expect(diagnosis.suggestions.some((item) => item.includes("trace export"))).toBe(true);
  });

  it("redacts secrets that appear in failure text", () => {
    const diagnosis = diagnoseFailure({
      message: "Codex exited with code 137 ARK_API_KEY=sk-supersecretvalue",
    });
    expect(JSON.stringify(diagnosis)).not.toContain("sk-supersecretvalue");
    expect(JSON.stringify(diagnosis)).not.toContain("ARK_API_KEY");
  });
});

describe("signatureFor", () => {
  it("encodes the exit code into the signature", () => {
    const diagnosis = diagnoseFailure({ message: "Codex exited with code 137" });
    expect(signatureFor(diagnosis.failureType, diagnosis.evidence)).toBe(
      "runtime_crash:exit137",
    );
  });

  it("falls back to the bare failure type", () => {
    const diagnosis = diagnoseFailure({ timedOut: true });
    expect(signatureFor(diagnosis.failureType, diagnosis.evidence)).toBe("tool_timeout");
  });
});

describe("summaryFor", () => {
  it("describes the recovery action in plain language", () => {
    expect(summaryFor("runtime_crash", "restart_resume")).toContain("restored the workspace");
    expect(summaryFor("tool_timeout", "retry")).toContain("retrying");
    expect(summaryFor("budget_projected_exceeded", "compress_resume")).toContain(
      "compressing context",
    );
    expect(summaryFor("budget_exceeded", "abort")).toContain("operator approval");
    expect(summaryFor("unknown", "abort")).toContain("aborting");
  });
});
