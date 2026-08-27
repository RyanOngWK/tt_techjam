import type { FailureType, InjectFailType } from "../types.js";

export function classifyFailure(input: {
  injected?: InjectFailType | null;
  timedOut?: boolean;
  cancelled?: boolean;
  budgetExceeded?: boolean;
  budgetProjectedExceeded?: boolean;
  message?: string | null;
}): FailureType {
  if (input.injected === "budget_projected_exceeded" || input.budgetProjectedExceeded) {
    return "budget_projected_exceeded";
  }
  if (input.injected === "budget_exceeded" || input.budgetExceeded) {
    return "budget_exceeded";
  }
  if (input.injected) {
    return input.injected;
  }
  if (input.timedOut) {
    return "tool_timeout";
  }
  if (input.cancelled) {
    return "unknown";
  }
  const message = (input.message ?? "").toLowerCase();
  if (message.includes("budget projected") || message.includes("projected exceed")) {
    return "budget_projected_exceeded";
  }
  if (message.includes("budget")) {
    return "budget_exceeded";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "tool_timeout";
  }
  if (
    message.includes("exited with code") ||
    message.includes("crash") ||
    message.includes("sigkill") ||
    message.includes("sigterm")
  ) {
    return "runtime_crash";
  }
  if (message.includes("econnreset") || message.includes("temporarily")) {
    return "transient_tool_error";
  }
  return "unknown";
}

export function severityFor(failureType: FailureType): "low" | "medium" | "high" {
  switch (failureType) {
    case "tool_timeout":
    case "transient_tool_error":
      return "medium";
    case "budget_projected_exceeded":
      return "medium";
    case "budget_exceeded":
    case "runtime_crash":
      return "high";
    default:
      return "high";
  }
}

export function totalTokens(usage: {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
} | null): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.outputTokens ?? 0)
  );
}
