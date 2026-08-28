import type {
  ActorType,
  EventStatus,
  SpanCategory,
  TraceEvent,
} from "../types.js";

export interface SpanNode extends TraceEvent {
  matched: boolean;
  children: SpanNode[];
}

export interface SpanFilter {
  category?: SpanCategory[];
  actor?: ActorType[];
  status?: EventStatus[];
  since?: string;
}

export interface RunSummary {
  spanCount: number;
  errorCount: number;
  durationMs: number | null;
}

export function matchesFilter(event: TraceEvent, filter: SpanFilter): boolean {
  if (filter.category && !filter.category.includes(event.category)) return false;
  if (filter.actor && !filter.actor.includes(event.actor)) return false;
  if (filter.status && !filter.status.includes(event.status)) return false;
  if (filter.since && event.timestamp < filter.since) return false;
  return true;
}

function hasCycle(
  event: TraceEvent,
  byId: Map<string, TraceEvent>,
): boolean {
  const seen = new Set<string>([event.id]);
  let current = event.parentEventId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = byId.get(current)?.parentEventId ?? null;
  }
  return false;
}

function prune(node: SpanNode): SpanNode | null {
  const children = node.children
    .map(prune)
    .filter((child): child is SpanNode => child !== null);
  if (!node.matched && children.length === 0) return null;
  return { ...node, children };
}

export function buildSpanTree(
  events: TraceEvent[],
  filter?: SpanFilter,
): SpanNode[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const nodes = new Map<string, SpanNode>();
  for (const event of events) {
    nodes.set(event.id, {
      ...event,
      matched: filter ? matchesFilter(event, filter) : true,
      children: [],
    });
  }

  const roots: SpanNode[] = [];
  for (const event of events) {
    const node = nodes.get(event.id);
    if (!node) continue;
    const parent = event.parentEventId ? nodes.get(event.parentEventId) : undefined;
    if (!parent || hasCycle(event, byId)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  if (!filter) return roots;
  return roots.map(prune).filter((node): node is SpanNode => node !== null);
}

export function summarizeRun(events: TraceEvent[]): RunSummary {
  if (events.length === 0) {
    return { spanCount: 0, errorCount: 0, durationMs: null };
  }
  const times = events
    .map((event) => Date.parse(event.timestamp))
    .filter((value) => Number.isFinite(value));
  return {
    spanCount: events.length,
    errorCount: events.filter((event) => event.status === "error").length,
    durationMs: times.length > 0 ? Math.max(...times) - Math.min(...times) : null,
  };
}
