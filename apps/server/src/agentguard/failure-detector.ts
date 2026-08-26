import type { FailureType, InjectFailType } from "../types.js";

export function classifyFailure(input: {
  injected?: InjectFailType | null;
  timedOut?: boolean;
  cancelled?: boolean;
  message?: string | null;
}): FailureType {
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
    case "runtime_crash":
      return "high";
    default:
      return "high";
  }
}
