import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  applyPatch,
  buildSettingsResponse,
  envDefaults,
  mergeSettings,
  patchAgentGuardSettingsSchema,
  validateEffectiveRatios,
} from "./settings.js";

const config = loadConfig({ NODE_ENV: "test" });

describe("AgentGuard settings", () => {
  it("merges env defaults when overrides are null", () => {
    const effective = mergeSettings(config, null);
    expect(effective).toEqual(envDefaults(config));
  });

  it("applies sparse overrides on top of env defaults", () => {
    const effective = mergeSettings(config, { tokenBudget: 12_000, softRatio: 0.6 });
    expect(effective.tokenBudget).toBe(12_000);
    expect(effective.softRatio).toBe(0.6);
    expect(effective.strictRatio).toBe(config.agentGuardBudgetStrictRatio);
  });

  it("patches overrides without dropping existing keys", () => {
    const patched = applyPatch({ tokenBudget: 10_000 }, { softRatio: 0.55 });
    expect(patched).toEqual({ tokenBudget: 10_000, softRatio: 0.55 });
  });

  it("rejects patch when strictRatio is not greater than softRatio", () => {
    const result = patchAgentGuardSettingsSchema.safeParse({
      softRatio: 0.9,
      strictRatio: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("validates effective ratios after partial patch", () => {
    expect(() =>
      validateEffectiveRatios(config, { softRatio: 0.9, strictRatio: 0.85 }),
    ).toThrow(/strictRatio must be greater than softRatio/);
  });

  it("builds a response with defaults, overrides, and effective", () => {
    const response = buildSettingsResponse(config, { tokenBudget: 25_000 });
    expect(response.defaults.tokenBudget).toBe(config.agentGuardTokenBudget);
    expect(response.overrides?.tokenBudget).toBe(25_000);
    expect(response.effective.tokenBudget).toBe(25_000);
  });
});
