import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type {
  EventStatus,
  EventType,
  TraceEvent,
} from "../types.js";
import { redactError, redactMetadata } from "./redact.js";

export async function appendTraceEvent(
  store: JsonStore,
  input: {
    runId: string;
    type: EventType;
    status: EventStatus;
    parentEventId?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<TraceEvent> {
  const event: TraceEvent = {
    id: randomUUID(),
    runId: input.runId,
    parentEventId: input.parentEventId ?? null,
    type: input.type,
    status: input.status,
    timestamp: new Date().toISOString(),
    durationMs: input.durationMs ?? null,
    metadata: redactMetadata(input.metadata ?? {}),
    error: redactError(input.error),
  };
  await store.mutate((database) => {
    database.events.push(event);
  });
  return event;
}

export function eventsForRun(store: JsonStore, runId: string): TraceEvent[] {
  return store
    .snapshot()
    .events.filter((event) => event.runId === runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
