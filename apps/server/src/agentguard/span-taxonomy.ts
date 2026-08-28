import type { ActorType, EventType, SpanCategory } from "../types.js";

const CATEGORY: Record<EventType, SpanCategory> = {
  RUN_STARTED: "orchestration",
  TURN: "orchestration",
  RUN_COMPLETED: "orchestration",
  RUN_FAILED: "orchestration",
  MODEL_CALL: "model_call",
  TOOL_CALL: "tool_call",
  ERROR: "tool_call",
  CHECKPOINT_CREATED: "checkpoint",
  CHECKPOINT_RESTORED: "checkpoint",
  INCIDENT_OPENED: "policy_decision",
  DIAGNOSIS_ISSUED: "policy_decision",
  DIAGNOSIS_VERDICT: "policy_decision",
  ALERT: "policy_decision",
  BUDGET_SOFT_LIMIT: "policy_decision",
  BUDGET_PROJECTED_EXCEED: "policy_decision",
  BUDGET_COMPRESSED: "policy_decision",
  BUDGET_EXCEEDED: "policy_decision",
  BUDGET_RAISED: "policy_decision",
  APPROVAL_REQUESTED: "human_approval",
  APPROVAL_GRANTED: "human_approval",
  APPROVAL_DENIED: "human_approval",
  RECOVERY_STARTED: "recovery",
  RECOVERY_COMPLETED: "recovery",
  RECOVERY_FAILED: "recovery",
  RECOVERY_VERIFIED: "recovery",
};

const ACTOR: Record<EventType, ActorType> = {
  RUN_STARTED: "human",
  APPROVAL_GRANTED: "human",
  APPROVAL_DENIED: "human",
  BUDGET_RAISED: "human",
  MODEL_CALL: "agent",
  TOOL_CALL: "agent",
  ERROR: "agent",
  TURN: "middleware",
  RUN_COMPLETED: "middleware",
  RUN_FAILED: "middleware",
  CHECKPOINT_CREATED: "middleware",
  CHECKPOINT_RESTORED: "middleware",
  INCIDENT_OPENED: "middleware",
  DIAGNOSIS_ISSUED: "middleware",
  DIAGNOSIS_VERDICT: "middleware",
  ALERT: "middleware",
  APPROVAL_REQUESTED: "middleware",
  BUDGET_SOFT_LIMIT: "middleware",
  BUDGET_PROJECTED_EXCEED: "middleware",
  BUDGET_COMPRESSED: "middleware",
  BUDGET_EXCEEDED: "middleware",
  RECOVERY_STARTED: "middleware",
  RECOVERY_COMPLETED: "middleware",
  RECOVERY_FAILED: "middleware",
  RECOVERY_VERIFIED: "middleware",
};

export function categoryForEventType(type: EventType): SpanCategory {
  return CATEGORY[type] ?? "orchestration";
}

export function actorForEventType(type: EventType): ActorType {
  return ACTOR[type] ?? "middleware";
}
