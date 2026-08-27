export type BudgetTier = "normal" | "soft_warn" | "strict";

export interface BudgetEstimates {
  softRatio: number;
  strictRatio: number;
  estModelTokens: number;
  estToolTokens: number;
  charsPerToken: number;
  nextTurnEstimate: number;
}

export function remainingTokens(tokensUsed: number, tokenBudget: number): number {
  if (tokenBudget <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, tokenBudget - tokensUsed);
}

export function budgetTier(
  tokensUsed: number,
  tokenBudget: number,
  estimates: Pick<BudgetEstimates, "softRatio" | "strictRatio">,
): BudgetTier {
  if (tokenBudget <= 0) return "normal";
  const ratio = tokensUsed / tokenBudget;
  if (ratio >= estimates.strictRatio) return "strict";
  if (ratio >= estimates.softRatio) return "soft_warn";
  return "normal";
}

export function projectUsage(input: {
  tokensUsed: number;
  modelCalls: number;
  toolCalls: number;
  streamBytes: number;
  estimates: Pick<
    BudgetEstimates,
    "estModelTokens" | "estToolTokens" | "charsPerToken"
  >;
}): number {
  const fromBytes =
    input.estimates.charsPerToken > 0
      ? Math.floor(input.streamBytes / input.estimates.charsPerToken)
      : 0;
  return (
    input.tokensUsed +
    input.modelCalls * input.estimates.estModelTokens +
    input.toolCalls * input.estimates.estToolTokens +
    fromBytes
  );
}

export function shouldCancelMidTurn(input: {
  projected: number;
  tokenBudget: number;
  tier: BudgetTier;
}): boolean {
  if (input.tokenBudget <= 0) return false;
  if (input.tier !== "strict") return false;
  return input.projected > input.tokenBudget;
}

export function shouldBlockPreTurn(
  tokensUsed: number,
  tokenBudget: number,
  estimates: Pick<BudgetEstimates, "nextTurnEstimate">,
): boolean {
  if (tokenBudget <= 0) return false;
  return tokensUsed + estimates.nextTurnEstimate > tokenBudget;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

export function wrapPrompt(input: {
  prompt: string;
  tokensUsed: number;
  tokenBudget: number;
  tier: BudgetTier;
  recentEventSummaries: string[];
}): string {
  const remaining = remainingTokens(input.tokensUsed, input.tokenBudget);
  const tierRules =
    input.tier === "strict"
      ? "Strict budget mode: prefer a final answer, use minimal tools, avoid exploratory work."
      : input.tier === "soft_warn"
        ? "Soft budget mode: keep responses concise and limit non-essential tool use."
        : "Stay within the remaining token budget; prefer concise output.";
  const recent =
    input.recentEventSummaries.length === 0
      ? "(none)"
      : input.recentEventSummaries
          .slice(-8)
          .map((line) => "- " + truncate(line, 120))
          .join("\n");
  return [
    "[AgentGuard budget control]",
    "tokensUsed/tokenBudget: " +
      input.tokensUsed +
      "/" +
      input.tokenBudget +
      " (remaining " +
      remaining +
      ")",
    "tier: " + input.tier,
    tierRules,
    "Original goal: " + truncate(input.prompt, 500),
    "Recent steps:",
    recent,
    "Continue with minimal tools and concise output.",
    "",
    input.prompt,
  ].join("\n");
}

export function summarizeTraceEvent(event: {
  type: string;
  status: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): string {
  const preview =
    typeof event.metadata?.preview === "string"
      ? truncate(event.metadata.preview, 80)
      : typeof event.metadata?.itemType === "string"
        ? String(event.metadata.itemType)
        : "";
  const err = event.error ? " err=" + truncate(event.error, 60) : "";
  return [event.type, event.status, preview, err].filter(Boolean).join(" ");
}
