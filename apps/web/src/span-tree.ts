// Intentionally duplicates apps/server/src/agentguard/span-tree.ts so filter
// chips can re-nest the tree in the browser with no round trip. Do not extract
// a shared package.

import type { ActorType, DurationSource, SpanCategory, SpanNode, TraceEvent } from "./types";

export interface SpanFilter {
  category?: SpanCategory[];
  actor?: ActorType[];
  status?: Array<"ok" | "error" | "running">;
}

export function matchesFilter(event: TraceEvent, filter: SpanFilter): boolean {
  if (filter.category?.length && !filter.category.includes(event.category)) return false;
  if (filter.actor?.length && !filter.actor.includes(event.actor)) return false;
  if (filter.status?.length && !filter.status.includes(event.status)) return false;
  return true;
}

function computeAttachWouldCycle(
  byId: Map<string, TraceEvent>,
): Map<string, boolean> {
  const memo = new Map<string, boolean>();

  for (const id of byId.keys()) {
    if (memo.has(id)) continue;

    const path: string[] = [];
    const seen = new Set<string>([id]);
    let current = byId.get(id)?.parentEventId ?? null;
    let result = false;

    while (current) {
      if (seen.has(current)) {
        result = true;
        break;
      }
      const cached = memo.get(current);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      seen.add(current);
      path.push(current);
      current = byId.get(current)?.parentEventId ?? null;
    }

    memo.set(id, result);
    for (const node of path) {
      if (!memo.has(node)) memo.set(node, result);
    }
  }

  return memo;
}

function prune(node: SpanNode): SpanNode | null {
  const children = node.children
    .map(prune)
    .filter((child): child is SpanNode => child !== null);
  if (!node.matched && children.length === 0) return null;
  return { ...node, children };
}

export function buildSpanTree(events: TraceEvent[], filter?: SpanFilter): SpanNode[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const nodes = new Map<string, SpanNode>();
  for (const event of events) {
    nodes.set(event.id, {
      ...event,
      matched: filter ? matchesFilter(event, filter) : true,
      children: [],
    });
  }

  const attachWouldCycle = computeAttachWouldCycle(byId);

  const roots: SpanNode[] = [];
  for (const event of events) {
    const node = nodes.get(event.id);
    if (!node) continue;
    const parent = event.parentEventId ? nodes.get(event.parentEventId) : undefined;
    if (!parent || attachWouldCycle.get(event.id)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }
  if (!filter) return roots;
  return roots.map(prune).filter((node): node is SpanNode => node !== null);
}

export function formatDuration(
  durationMs: number | null,
  durationSource: DurationSource | null,
): string {
  if (durationMs === null) return "—";
  const prefix = durationSource === "inter_item_delta" ? "~" : "";
  if (durationMs < 1000) return prefix + durationMs + "ms";
  return prefix + (durationMs / 1000).toFixed(1) + "s";
}
