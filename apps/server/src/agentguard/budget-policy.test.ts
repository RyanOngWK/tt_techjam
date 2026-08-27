import { describe, expect, it } from "vitest";
import {
  budgetTier,
  projectUsage,
  remainingTokens,
  shouldBlockPreTurn,
  shouldCancelMidTurn,
  wrapPrompt,
  type BudgetEstimates,
} from "./budget-policy.js";

const estimates: BudgetEstimates = {
  softRatio: 0.5,
  strictRatio: 0.85,
  estModelTokens: 2000,
  estToolTokens: 1000,
  charsPerToken: 4,
  nextTurnEstimate: 8000,
};

describe("budgetTier", () => {
  it("returns normal below soft ratio", () => {
    expect(budgetTier(0, 10_000, estimates)).toBe("normal");
    expect(budgetTier(4999, 10_000, estimates)).toBe("normal");
  });

  it("returns soft_warn between soft and strict", () => {
    expect(budgetTier(5000, 10_000, estimates)).toBe("soft_warn");
    expect(budgetTier(8499, 10_000, estimates)).toBe("soft_warn");
  });

  it("returns strict at or above strict ratio", () => {
    expect(budgetTier(8500, 10_000, estimates)).toBe("strict");
    expect(budgetTier(10_000, 10_000, estimates)).toBe("strict");
  });

  it("returns normal when budget disabled", () => {
    expect(budgetTier(100, 0, estimates)).toBe("normal");
  });
});

describe("projectUsage", () => {
  it("sums used tokens with span and byte estimates", () => {
    expect(
      projectUsage({
        tokensUsed: 1000,
        modelCalls: 2,
        toolCalls: 1,
        streamBytes: 400,
        estimates,
      }),
    ).toBe(1000 + 4000 + 1000 + 100);
  });
});

describe("shouldCancelMidTurn", () => {
  it("cancels only in strict tier when projected exceeds budget", () => {
    expect(
      shouldCancelMidTurn({
        projected: 10_001,
        tokenBudget: 10_000,
        tier: "strict",
      }),
    ).toBe(true);
    expect(
      shouldCancelMidTurn({
        projected: 10_001,
        tokenBudget: 10_000,
        tier: "soft_warn",
      }),
    ).toBe(false);
    expect(
      shouldCancelMidTurn({
        projected: 9000,
        tokenBudget: 10_000,
        tier: "strict",
      }),
    ).toBe(false);
  });

  it("never cancels when budget disabled", () => {
    expect(
      shouldCancelMidTurn({
        projected: 999_999,
        tokenBudget: 0,
        tier: "strict",
      }),
    ).toBe(false);
  });
});

describe("shouldBlockPreTurn", () => {
  it("blocks when used plus next-turn estimate exceeds budget", () => {
    expect(shouldBlockPreTurn(1000, 10_000, estimates)).toBe(false);
    expect(shouldBlockPreTurn(2000, 10_000, estimates)).toBe(false);
    expect(shouldBlockPreTurn(2001, 10_000, estimates)).toBe(true);
  });

  it("never blocks when budget disabled", () => {
    expect(shouldBlockPreTurn(999_999, 0, estimates)).toBe(false);
  });
});

describe("wrapPrompt", () => {
  it("prepends budget control block with remaining and tier rules", () => {
    const wrapped = wrapPrompt({
      prompt: "Build a calculator",
      tokensUsed: 6000,
      tokenBudget: 10_000,
      tier: "soft_warn",
      recentEventSummaries: ["MODEL_CALL ok", "TOOL_CALL ok"],
    });
    expect(wrapped).toContain("[AgentGuard budget control]");
    expect(wrapped).toContain("6000/10000");
    expect(wrapped).toContain(String(remainingTokens(6000, 10_000)));
    expect(wrapped).toContain("soft_warn");
    expect(wrapped).toContain("Build a calculator");
    expect(wrapped).toContain("MODEL_CALL ok");
    expect(wrapped).toContain("concise");
  });

  it("uses stricter wording for strict tier", () => {
    const wrapped = wrapPrompt({
      prompt: "Finish the task",
      tokensUsed: 9000,
      tokenBudget: 10_000,
      tier: "strict",
      recentEventSummaries: [],
    });
    expect(wrapped).toContain("strict");
    expect(wrapped).toMatch(/minimal tools|no new tools|final answer/i);
  });
});
