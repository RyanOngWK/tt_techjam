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
    case "budget_projected_exceeded":
      return "compress_resume";
    case "budget_exceeded":
    case "unknown":
    default:
      return "abort";
  }
}

export function strategyRationaleFor(
  failureType: FailureType,
  strategy: RecoveryStrategy,
): string {
  switch (strategy) {
    case "retry":
      return "The failure looks transient (timeout or provider blip), so AgentGuard retries the same prompt without changing state.";
    case "restart_resume":
      return "A runtime crash is not safely retryable; AgentGuard restores the latest checkpoint and resumes the Codex session from there.";
    case "compress_resume":
      return "The next turn would exceed the remaining token budget, so AgentGuard compresses context and resumes within budget.";
    case "abort":
      return failureType === "unknown"
        ? "No known failure signature matched, so AgentGuard will not guess a recovery and aborts instead."
        : "No safe automatic recovery exists for this failure class, so AgentGuard aborts and alerts the operator.";
    default:
      return "No recovery applied.";
  }
}

export function shouldAbortAfterAttempts(
  failureType: FailureType,
  attemptCountForStrategy: number,
  maxCompressRecoveries = 2,
): boolean {
  if (failureType === "unknown" || failureType === "budget_exceeded") return true;
  if (failureType === "budget_projected_exceeded") {
    return attemptCountForStrategy >= maxCompressRecoveries;
  }
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
