import { z } from "zod";
import type { AppConfig } from "../config.js";
import type {
  AgentGuardSettingsEffective,
  AgentGuardSettingsOverrides,
  AgentGuardSettingsResponse,
} from "../types.js";

const overrideFieldSchema = {
  tokenBudget: z.number().int().min(0),
  softRatio: z.number().min(0).max(1),
  strictRatio: z.number().min(0).max(1),
  estModelTokens: z.number().int().min(0),
  estToolTokens: z.number().int().min(0),
  charsPerToken: z.number().positive(),
  nextTurnEstimate: z.number().int().min(0),
  maxCompressRecoveries: z.number().int().min(0),
  requireApprovalAfterCrashes: z.number().int().min(1),
} as const;

export const patchAgentGuardSettingsSchema = z
  .object({
    tokenBudget: overrideFieldSchema.tokenBudget.optional(),
    softRatio: overrideFieldSchema.softRatio.optional(),
    strictRatio: overrideFieldSchema.strictRatio.optional(),
    estModelTokens: overrideFieldSchema.estModelTokens.optional(),
    estToolTokens: overrideFieldSchema.estToolTokens.optional(),
    charsPerToken: overrideFieldSchema.charsPerToken.optional(),
    nextTurnEstimate: overrideFieldSchema.nextTurnEstimate.optional(),
    maxCompressRecoveries: overrideFieldSchema.maxCompressRecoveries.optional(),
    requireApprovalAfterCrashes:
      overrideFieldSchema.requireApprovalAfterCrashes.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .superRefine((value, context) => {
    if (
      value.softRatio !== undefined &&
      value.strictRatio !== undefined &&
      value.strictRatio <= value.softRatio
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "strictRatio must be greater than softRatio",
        path: ["strictRatio"],
      });
    }
  });

export type PatchAgentGuardSettingsInput = z.infer<
  typeof patchAgentGuardSettingsSchema
>;

export function envDefaults(config: AppConfig): AgentGuardSettingsEffective {
  return {
    tokenBudget: config.agentGuardTokenBudget,
    softRatio: config.agentGuardBudgetSoftRatio,
    strictRatio: config.agentGuardBudgetStrictRatio,
    estModelTokens: config.agentGuardBudgetEstModelTokens,
    estToolTokens: config.agentGuardBudgetEstToolTokens,
    charsPerToken: config.agentGuardBudgetCharsPerToken,
    nextTurnEstimate: config.agentGuardBudgetNextTurnEstimate,
    maxCompressRecoveries: config.agentGuardBudgetMaxCompressRecoveries,
    requireApprovalAfterCrashes: config.agentGuardRequireApprovalAfterCrashes,
  };
}

export function mergeSettings(
  config: AppConfig,
  overrides: AgentGuardSettingsOverrides | null,
): AgentGuardSettingsEffective {
  const defaults = envDefaults(config);
  if (!overrides) return defaults;
  return {
    tokenBudget: overrides.tokenBudget ?? defaults.tokenBudget,
    softRatio: overrides.softRatio ?? defaults.softRatio,
    strictRatio: overrides.strictRatio ?? defaults.strictRatio,
    estModelTokens: overrides.estModelTokens ?? defaults.estModelTokens,
    estToolTokens: overrides.estToolTokens ?? defaults.estToolTokens,
    charsPerToken: overrides.charsPerToken ?? defaults.charsPerToken,
    nextTurnEstimate: overrides.nextTurnEstimate ?? defaults.nextTurnEstimate,
    maxCompressRecoveries:
      overrides.maxCompressRecoveries ?? defaults.maxCompressRecoveries,
    requireApprovalAfterCrashes:
      overrides.requireApprovalAfterCrashes ??
      defaults.requireApprovalAfterCrashes,
  };
}

export function applyPatch(
  current: AgentGuardSettingsOverrides | null,
  patch: PatchAgentGuardSettingsInput,
): AgentGuardSettingsOverrides {
  const next: AgentGuardSettingsOverrides = { ...(current ?? {}) };
  for (const key of Object.keys(patch) as (keyof PatchAgentGuardSettingsInput)[]) {
    const value = patch[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

export function validateEffectiveRatios(
  config: AppConfig,
  overrides: AgentGuardSettingsOverrides,
): void {
  const effective = mergeSettings(config, overrides);
  if (effective.strictRatio <= effective.softRatio) {
    throw new Error("strictRatio must be greater than softRatio");
  }
}

export function buildSettingsResponse(
  config: AppConfig,
  overrides: AgentGuardSettingsOverrides | null,
): AgentGuardSettingsResponse {
  return {
    defaults: envDefaults(config),
    overrides: overrides ? structuredClone(overrides) : null,
    effective: mergeSettings(config, overrides),
  };
}
