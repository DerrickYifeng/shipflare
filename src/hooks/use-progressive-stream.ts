'use client';

import { useCallback, useState } from 'react';
import { useSSEChannel } from './use-sse-channel';

export type Pipeline = 'plan' | 'reply' | 'discovery';
export type ItemState =
  | 'queued'
  | 'searching'
  | 'searched'
  | 'drafting'
  | 'ready'
  | 'failed';

export interface StreamEnvelope<T = unknown> {
  type?: string;
  pipeline: Pipeline;
  itemId: string;
  state: ItemState;
  data?: T;
  seq?: number;
}

export interface ItemSnapshot<T = unknown> {
  state: ItemState;
  data?: T;
  updatedAt: number;
}

/**
 * Default SSE channel per pipeline. `plan` and `discovery` flow through the
 * `agents` topic (one long-lived subscription for all agent progress);
 * `reply` is emitted on `drafts` since reply drafts are the primary payload.
 */
const DEFAULT_CHANNEL: Record<Pipeline, 'agents' | 'drafts'> = {
  plan: 'agents',
  discovery: 'agents',
  reply: 'drafts',
};

/**
 * Consume the unified `pipeline` SSE envelope and expose a per-item snapshot
 * map for a single pipeline (plan / discovery / reply).
 *
 * - Filters to events matching `pipeline` only.
 * - Stores the latest snapshot per `itemId`.
 * - Dedups by monotone `seq`: drops an envelope whose `seq` is <= the current
 *   stored one (so late or duplicated events can't regress state).
 * - `reset(itemId)` puts an item back into `queued` so the UI can show a
 *   retry-in-flight state without waiting for the server echo.
 */
export function useProgressiveStream<T = unknown>(pipeline: Pipeline) {
  const [items, setItems] = useState<Map<string, ItemSnapshot<T>>>(
    () => new Map(),
  );

  useSSEChannel(DEFAULT_CHANNEL[pipeline], (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as StreamEnvelope<T>;
    if (e.type !== 'pipeline' || e.pipeline !== pipeline || !e.itemId) return;
    setItems((prev) => {
      const curr = prev.get(e.itemId);
      const nextSeq = e.seq ?? Date.now();
      if (curr && curr.updatedAt >= nextSeq) return prev;
      const next = new Map(prev);
      next.set(e.itemId, {
        state: e.state,
        data: e.data,
        updatedAt: nextSeq,
      });
      return next;
    });
  });

  const reset = useCallback((itemId: string) => {
    setItems((prev) => {
      const next = new Map(prev);
      next.set(itemId, { state: 'queued', updatedAt: Date.now() });
      return next;
    });
  }, []);

  return { items, reset };
}
