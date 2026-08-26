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
    case "budget_exceeded":
    case "unknown":
    default:
      return "abort";
  }
}

export function shouldAbortAfterAttempts(
  failureType: FailureType,
  attemptCountForStrategy: number,
): boolean {
  if (failureType === "unknown" || failureType === "budget_exceeded") return true;
  if (failureType === "runtime_crash") {
    return attemptCountForStrategy >= MAX_CRASH_RESTARTS;
  }
  if (failureType === "tool_timeout" || failureType === "transient_tool_error") {
    return attemptCountForStrategy > MAX_TIMEOUT_RETRIES;
  }
  return true;
}

/** Crash count that should pause for human approval instead of auto-recovering. */
export function requiresApprovalForCrash(
  priorCrashRecoveries: number,
  requireAfterCrashes: number,
): boolean {
  // priorCrashRecoveries is how many restart_resume attempts already ran.
  // requireAfterCrashes=2 means the 2nd crash needs approval (1 auto recovery used).
  return priorCrashRecoveries + 1 >= requireAfterCrashes;
}

export function retryBackoffMs(attemptIndex: number): number {
  return attemptIndex <= 1 ? 0 : 10;
}
