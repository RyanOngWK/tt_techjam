import type { FailureType, RecoveryStrategy } from "../types.js";

export const MAX_TIMEOUT_RETRIES = 2;
export const MAX_CRASH_RESTARTS = 1;

export function selectStrategy(failureType: FailureType): RecoveryStrategy {
  switch (failureType) {
    case "tool_timeout":
    case "transient_tool_error":
      return "retry";
    case "runtime_crash":
      return "restart_resume";
    case "unknown":
    default:
      return "abort";
  }
}

export function shouldAbortAfterAttempts(
  failureType: FailureType,
  attemptCountForStrategy: number,
): boolean {
  if (failureType === "unknown") return true;
  if (failureType === "runtime_crash") {
    return attemptCountForStrategy >= MAX_CRASH_RESTARTS;
  }
  if (failureType === "tool_timeout" || failureType === "transient_tool_error") {
    return attemptCountForStrategy > MAX_TIMEOUT_RETRIES;
  }
  return true;
}

export function retryBackoffMs(attemptIndex: number): number {
  // Keep MVP backoff tiny so automated tests and demos stay snappy.
  return attemptIndex <= 1 ? 0 : 10;
}
