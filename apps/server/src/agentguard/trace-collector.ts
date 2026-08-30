import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type {
  ActorType,
  DurationSource,
  EventStatus,
  EventType,
  SpanCategory,
  TraceEvent,
} from "../types.js";
import { redactError, redactMetadata } from "./redact.js";
import { actorForEventType, categoryForEventType } from "./span-taxonomy.js";

export interface SpanInput {
  runId: string;
  type: EventType;
  status?: EventStatus;
  category?: SpanCategory;
  actor?: ActorType;
  parentEventId?: string | null;
  attemptIndex?: number;
  durationMs?: number | null;
  durationSource?: DurationSource | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface SpanPatch {
  status: EventStatus;
  error?: string | null;
  metadata?: Record<string, unknown>;
  durationSource?: DurationSource;
}

export async function appendTraceEvent(
  store: JsonStore,
  input: SpanInput & { status: EventStatus },
): Promise<TraceEvent> {
  const event: TraceEvent = {
    id: randomUUID(),
    runId: input.runId,
    parentEventId: input.parentEventId ?? null,
    type: input.type,
    category: input.category ?? categoryForEventType(input.type),
    actor: input.actor ?? actorForEventType(input.type),
    status: input.status,
    timestamp: new Date().toISOString(),
    endedAt: null,
    durationMs: input.durationMs ?? null,
    durationSource: input.durationSource ?? null,
    attemptIndex: input.attemptIndex ?? 0,
    metadata: redactMetadata(input.metadata ?? {}),
    error: redactError(input.error),
  };
  await store.mutate((database) => {
    database.events.push(event);
  });
  return event;
}

export async function startSpan(store: JsonStore, input: SpanInput): Promise<string> {
  const event = await appendTraceEvent(store, { ...input, status: "running" });
  return event.id;
}

export async function endSpan(
  store: JsonStore,
  spanId: string,
  patch: SpanPatch,
): Promise<void> {
  const endedAt = new Date().toISOString();
  await store.mutate((database) => {
    const span = database.events.find((event) => event.id === spanId);
    if (!span) return;
    span.status = patch.status;
    span.endedAt = endedAt;
    span.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(span.timestamp));
    span.durationSource = patch.durationSource ?? "measured";
    if (patch.error !== undefined) {
      span.error = redactError(patch.error);
    }
    if (patch.metadata) {
      span.metadata = { ...span.metadata, ...redactMetadata(patch.metadata) };
    }
  });
}

export function eventsForRun(store: JsonStore, runId: string): TraceEvent[] {
  return store
    .snapshot()
    .events.filter((event) => event.runId === runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
