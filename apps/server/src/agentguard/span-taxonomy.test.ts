import { describe, expect, it } from "vitest";
import type { EventType } from "../types.js";
import { actorForEventType, categoryForEventType } from "./span-taxonomy.js";

const ALL_EVENT_TYPES: EventType[] = [
  "RUN_STARTED", "TURN", "RUN_COMPLETED", "RUN_FAILED", "MODEL_CALL",
  "TOOL_CALL", "CHECKPOINT_CREATED", "CHECKPOINT_RESTORED", "ERROR",
  "INCIDENT_OPENED", "DIAGNOSIS_ISSUED", "DIAGNOSIS_VERDICT",
  "RECOVERY_STARTED", "RECOVERY_COMPLETED", "RECOVERY_FAILED",
  "RECOVERY_VERIFIED", "ALERT", "APPROVAL_REQUESTED", "APPROVAL_GRANTED",
  "APPROVAL_DENIED", "BUDGET_SOFT_LIMIT", "BUDGET_PROJECTED_EXCEED",
  "BUDGET_COMPRESSED", "BUDGET_EXCEEDED", "BUDGET_RAISED",
];

describe("span taxonomy", () => {
  it("assigns a category and actor to every event type", () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(categoryForEventType(type), type).toBeTruthy();
      expect(actorForEventType(type), type).toBeTruthy();
    }
  });

  it("categorises orchestration, model, and tool spans", () => {
    expect(categoryForEventType("TURN")).toBe("orchestration");
    expect(categoryForEventType("MODEL_CALL")).toBe("model_call");
    expect(categoryForEventType("TOOL_CALL")).toBe("tool_call");
    expect(categoryForEventType("CHECKPOINT_RESTORED")).toBe("checkpoint");
    expect(categoryForEventType("DIAGNOSIS_ISSUED")).toBe("policy_decision");
    expect(categoryForEventType("APPROVAL_GRANTED")).toBe("human_approval");
    expect(categoryForEventType("RECOVERY_VERIFIED")).toBe("recovery");
  });

  it("attributes human decisions to the human actor", () => {
    expect(actorForEventType("RUN_STARTED")).toBe("human");
    expect(actorForEventType("APPROVAL_GRANTED")).toBe("human");
    expect(actorForEventType("APPROVAL_DENIED")).toBe("human");
    expect(actorForEventType("BUDGET_RAISED")).toBe("human");
    expect(actorForEventType("MODEL_CALL")).toBe("agent");
    expect(actorForEventType("TOOL_CALL")).toBe("agent");
    expect(actorForEventType("RECOVERY_STARTED")).toBe("middleware");
  });
});
