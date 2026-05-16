'use client';

// ActivityTrail — collapsible activity feed for the CMO conversation
// (Task 13 of plan 2026-05-15-agent-activity-feed.md).
//
// Consumes raw `ActivityEvent[]` (typically from useCmoActivity), groups
// `*_start` with their matching `*_finish`, attaches children whose
// `parentEventId` points at a parent start, derives status, and renders:
//
//   ┌────────────────────────────────────────────────┐
//   │ ◐ Asking Head of Growth…       ← rolling ticker │
//   │ Activity (3) ▾                                  │
//   │   ◐ Asking Head of Growth                       │
//   │     ✓ x_search                                  │
//   │   ✓ Done                                        │
//   └────────────────────────────────────────────────┘
//
// Defensive sort (Task 10 M2 mitigation): events with the same `createdAt`
// (same millisecond start/finish race) are ordered so `*_start` precedes
// `*_finish`. This ensures we don't treat a finish as the latest leaf.
//
// `subagent_text_delta` events are NOT rendered as standalone rows. Their
// text is aggregated onto the parent dispatch row's `sub` line (latest
// chunk wins, mirroring what the label map does for the standalone case).

import { useEffect, useMemo, useState } from 'react';
import type { ActivityEvent, ActivityKind } from '@shipflare/shared';
import { labelEvent, type ActivityLabel } from '@/lib/activity-labels';
import { ActivityRow } from './activity-row';
import { ActivityToggle } from './activity-toggle';

export interface ActivityTrailProps {
  events: ActivityEvent[];
  /** Start expanded. Defaults to false (collapsed). */
  defaultOpen?: boolean;
  /** Suppress the rolling ticker line. */
  hideTicker?: boolean;
  /** Visual wrapper. `'dispatch-card'` adds a framed card. */
  shell?: 'inline' | 'dispatch-card';
}

interface Group {
  start: ActivityEvent;
  finish?: ActivityEvent;
  children: Group[];
  status: 'running' | 'done' | 'error';
  /** Latest aggregated text delta from a child, for the row's sub line. */
  latestDelta?: string;
}

const FINISH_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'turn_finish',
  'subagent_finish',
  'tool_call_finish',
  'subagent_tool_call_finish',
  'skill_finish',
]);

/** Predicate: is this a "start"-like event that can be a leaf or parent? */
function isStartLike(kind: ActivityKind): boolean {
  return (
    kind === 'turn_start' ||
    kind === 'subagent_dispatch' ||
    kind === 'tool_call_start' ||
    kind === 'subagent_tool_call_start' ||
    kind === 'skill_invoke'
  );
}

/** Predicate: given a start kind, what kind would finish it? */
function matchingFinishKind(startKind: ActivityKind): ActivityKind | null {
  switch (startKind) {
    case 'turn_start':
      return 'turn_finish';
    case 'subagent_dispatch':
      return 'subagent_finish';
    case 'tool_call_start':
      return 'tool_call_finish';
    case 'subagent_tool_call_start':
      return 'subagent_tool_call_finish';
    case 'skill_invoke':
      return 'skill_finish';
    default:
      return null;
  }
}

function derive(finish?: ActivityEvent): Group['status'] {
  if (!finish) return 'running';
  const p = finish.payload as { status?: 'ok' | 'error' };
  return p.status === 'error' ? 'error' : 'done';
}

/** Build the composite key used to pair a start event with its finish. */
function finishKey(
  sourceAgent: string,
  parentEventId: string | null,
  finishKind: ActivityKind,
): string {
  return `${sourceAgent}|${parentEventId ?? ''}|${finishKind}`;
}

/**
 * Pair starts with finishes and build a 2-level group tree. Top-level
 * groups are starts with `parentEventId === null`; children are starts
 * whose `parentEventId` points at a top-level start.
 *
 * Assumes the input is already sorted (start-before-finish at same ms).
 *
 * Implementation is O(n): a single pass builds three indexes
 *   - childrenByParent : parent event id → starts that point at it
 *   - finishBuckets    : (sourceAgent, parentEventId, finishKind) → finishes
 *                        (kept in insertion order so we can pop the earliest
 *                         unconsumed finish for each start)
 *   - latestDeltaByParent : parent start id → latest streaming text
 *
 * Then a second pass walks top-level starts in order, pairing each with
 * the first unconsumed finish whose createdAt >= the start's createdAt.
 * Consumption avoids cross-pairing when several start/finish pairs share
 * the same (sourceAgent, parentEventId).
 */
export function buildGroups(events: ActivityEvent[]): Group[] {
  // Index 1: parentEventId → child start events (in input order).
  const childrenByParent = new Map<string, ActivityEvent[]>();
  // Index 2: composite key → queue of finish events (in input order).
  // Use a head-pointer object so we don't pay O(n) shift() per consume.
  type Bucket = { events: ActivityEvent[]; head: number };
  const finishBuckets = new Map<string, Bucket>();
  // Index 3: latest text delta keyed by its parent start id.
  const latestDeltaByParent = new Map<string, string>();

  for (const e of events) {
    if (e.kind === 'subagent_text_delta') {
      if (e.parentEventId) {
        const p = e.payload as { text?: string };
        if (typeof p.text === 'string') {
          latestDeltaByParent.set(e.parentEventId, p.text);
        }
      }
      continue;
    }

    if (FINISH_KINDS.has(e.kind)) {
      const key = finishKey(e.sourceAgent, e.parentEventId, e.kind);
      let bucket = finishBuckets.get(key);
      if (!bucket) {
        bucket = { events: [], head: 0 };
        finishBuckets.set(key, bucket);
      }
      bucket.events.push(e);
      continue;
    }

    // Start-like (or other non-finish, non-delta) event: index as a child
    // if it has a parent.
    if (e.parentEventId) {
      const list = childrenByParent.get(e.parentEventId) ?? [];
      list.push(e);
      childrenByParent.set(e.parentEventId, list);
    }
  }

  // Resolve a finish for `start` by popping the earliest unconsumed finish
  // from the appropriate bucket whose createdAt >= start.createdAt.
  const consumeFinish = (start: ActivityEvent): ActivityEvent | undefined => {
    const wantKind = matchingFinishKind(start.kind);
    if (!wantKind) return undefined;
    const bucket = finishBuckets.get(
      finishKey(start.sourceAgent, start.parentEventId, wantKind),
    );
    if (!bucket) return undefined;
    // Skip past any finishes that are earlier than this start (they must
    // already have been consumed by an earlier start, but be safe).
    while (bucket.head < bucket.events.length) {
      const candidate = bucket.events[bucket.head]!;
      if (candidate.id === start.id) {
        // Shouldn't happen (start vs finish kinds differ), but guard.
        bucket.head++;
        continue;
      }
      if (candidate.createdAt >= start.createdAt) {
        bucket.head++;
        return candidate;
      }
      // Finish predates this start — discard it (already orphaned).
      bucket.head++;
    }
    return undefined;
  };

  const groups: Group[] = [];
  for (const e of events) {
    if (FINISH_KINDS.has(e.kind)) continue;
    if (e.kind === 'subagent_text_delta') continue;
    if (e.parentEventId !== null) continue; // children attached below
    if (!isStartLike(e.kind)) continue;

    const finish = consumeFinish(e);
    const childStarts = (childrenByParent.get(e.id) ?? []).filter(
      (c) => isStartLike(c.kind) && c.kind !== 'subagent_text_delta',
    );
    const children: Group[] = childStarts.map((c) => {
      const cFinish = consumeFinish(c);
      return {
        start: c,
        finish: cFinish,
        children: [],
        status: derive(cFinish),
        latestDelta: latestDeltaByParent.get(c.id),
      };
    });

    groups.push({
      start: e,
      finish,
      children,
      status: derive(finish),
      latestDelta: latestDeltaByParent.get(e.id),
    });
  }
  return groups;
}

/**
 * Merge a `latestDelta` (from aggregated `subagent_text_delta` children)
 * into the label's `sub` line. If the label already has a sub, the delta
 * wins (it's fresher).
 */
function applyDelta(label: ActivityLabel, delta?: string): ActivityLabel {
  if (!delta) return label;
  return { ...label, sub: delta.slice(-80) };
}

export function ActivityTrail({
  events,
  defaultOpen = false,
  hideTicker = false,
  shell = 'inline',
}: ActivityTrailProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Defensive sort: createdAt asc, then kind priority (*_start / dispatch /
  // invoke before *_finish). Mitigates Task 10 review's M2 finding where a
  // start + finish can emit in the same ms and arrive in reverse order.
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      const aFinish = FINISH_KINDS.has(a.kind);
      const bFinish = FINISH_KINDS.has(b.kind);
      if (aFinish && !bFinish) return 1;
      if (!aFinish && bFinish) return -1;
      return 0;
    });
  }, [events]);

  const groups = useMemo(() => buildGroups(sortedEvents), [sortedEvents]);

  // Ticker: the latest start-like event with no matching finish.
  const runningLeaf = useMemo(() => {
    for (let i = sortedEvents.length - 1; i >= 0; i--) {
      const e = sortedEvents[i]!;
      if (!isStartLike(e.kind)) continue;
      const wantKind = matchingFinishKind(e.kind);
      if (!wantKind) continue;
      const finished = sortedEvents.some(
        (c) =>
          c.kind === wantKind &&
          c.parentEventId === e.parentEventId &&
          c.sourceAgent === e.sourceAgent &&
          c.createdAt >= e.createdAt &&
          c.id !== e.id,
      );
      if (!finished) return e;
    }
    return null;
  }, [sortedEvents]);

  // Auto-hide the ticker 1.5s after the last running leaf clears.
  const [tickerVisible, setTickerVisible] = useState(true);
  useEffect(() => {
    if (runningLeaf) {
      setTickerVisible(true);
      return;
    }
    const timer = setTimeout(() => setTickerVisible(false), 1500);
    return () => clearTimeout(timer);
  }, [runningLeaf]);

  const containerClass =
    shell === 'dispatch-card'
      ? 'rounded-2xl border border-gray-200 p-4'
      : 'pl-2';

  return (
    <div className={containerClass}>
      {!hideTicker && tickerVisible && runningLeaf ? (
        <div className="mb-1 truncate text-xs text-gray-500">
          ◐ {labelEvent(runningLeaf).headline}…
        </div>
      ) : null}
      <ActivityToggle
        count={events.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open ? (
        <div className="mt-1 space-y-0">
          {groups.map((g) => (
            <div key={g.start.id}>
              <ActivityRow
                eventId={g.start.id}
                label={applyDelta(
                  // When the group has finished, prefer the finish event's
                  // label (e.g. "Head of Growth finished") over the start's
                  // ("Asking Head of Growth"). Running groups use the start.
                  labelEvent(g.finish ?? g.start),
                  g.latestDelta,
                )}
                status={g.status}
              />
              {g.children.map((c) => (
                <ActivityRow
                  key={c.start.id}
                  eventId={c.start.id}
                  label={applyDelta(
                    labelEvent(c.finish ?? c.start),
                    c.latestDelta,
                  )}
                  status={c.status}
                  indent={1}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
