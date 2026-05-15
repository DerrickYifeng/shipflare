'use client';

/**
 * Streaming-partial state, isolated from the conversation reducer.
 *
 * Background: `team-desk.tsx` used to pass `partials: ReadonlyMap<…>`
 * straight into `<Conversation>`. Every token append produced a new Map →
 * Conversation re-rendered → the whole `stitchLeadMessages` reducer ran on
 * every keystroke of the assistant. This module provides a per-tree store
 * (one `StreamingStore` instance per `StreamingProvider`) backed by
 * `useSyncExternalStore`, so token deltas mutate a single ref and only the
 * leaf component that subscribes to the matching `messageId` re-renders.
 *
 * A2 will drop the `partials` / `toolInputPartials` props from
 * `<Conversation>` entirely once the bottom rail takes over placeholder
 * rendering for in-flight streams. For A1 we install the plumbing and the
 * leaf-reads-from-context path; the existing prop path remains untouched
 * so the UI cannot regress.
 */

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export interface StreamingPartial {
  text: string;
  updatedAt: number;
}

export interface StreamingDispatch {
  appendDelta: (messageId: string, delta: string) => void;
  appendToolInput: (toolUseId: string, delta: string) => void;
  /**
   * Remove a streaming-text partial (called when the durable `agent_text`
   * lands, on stall sweeps, and on reconnect wipes). Keyspace is separate
   * from tool inputs — finalizing a messageId never touches the
   * tool-input map, so the two keyspaces can safely overlap.
   */
  finalizePartial: (messageId: string) => void;
  /**
   * Remove a tool-input partial (called when the durable `tool_call`
   * lands). Independent keyspace from `finalizePartial`.
   */
  finalizeToolInput: (toolUseId: string) => void;
}

/**
 * Per-tree store. Plain class, no React state — subscribers get notified
 * by snapshot identity so `useSyncExternalStore` only re-renders the
 * subset of components whose subscribed key actually changed.
 *
 * Partials (streaming text) and toolInputs (streaming tool-input JSON)
 * live in completely independent keyspaces. A messageId and a toolUseId
 * that happen to collide on the same string will not cross-contaminate
 * subscribers — each has its own Map for state and for subscribers.
 */
class StreamingStore implements StreamingDispatch {
  private readonly partials = new Map<string, StreamingPartial>();
  private readonly toolInputs = new Map<string, string>();
  private readonly partialSubscribers = new Map<string, Set<() => void>>();
  private readonly toolInputSubscribers = new Map<string, Set<() => void>>();

  subscribePartial(messageId: string, cb: () => void): () => void {
    return this.subscribeOn(this.partialSubscribers, messageId, cb);
  }

  subscribeToolInput(toolUseId: string, cb: () => void): () => void {
    return this.subscribeOn(this.toolInputSubscribers, toolUseId, cb);
  }

  getPartial(messageId: string): StreamingPartial | undefined {
    return this.partials.get(messageId);
  }

  getToolInput(toolUseId: string): string | undefined {
    return this.toolInputs.get(toolUseId);
  }

  appendDelta = (messageId: string, delta: string): void => {
    const prev = this.partials.get(messageId);
    this.partials.set(messageId, {
      text: (prev?.text ?? '') + delta,
      updatedAt: Date.now(),
    });
    this.notify(this.partialSubscribers, messageId);
  };

  appendToolInput = (toolUseId: string, delta: string): void => {
    const prev = this.toolInputs.get(toolUseId) ?? '';
    this.toolInputs.set(toolUseId, prev + delta);
    this.notify(this.toolInputSubscribers, toolUseId);
  };

  finalizePartial = (messageId: string): void => {
    if (!this.partials.delete(messageId)) return;
    this.notify(this.partialSubscribers, messageId);
  };

  finalizeToolInput = (toolUseId: string): void => {
    if (!this.toolInputs.delete(toolUseId)) return;
    this.notify(this.toolInputSubscribers, toolUseId);
  };

  private subscribeOn(
    map: Map<string, Set<() => void>>,
    key: string,
    cb: () => void,
  ): () => void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(cb);
    return () => {
      const current = map.get(key);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) map.delete(key);
    };
  }

  private notify(map: Map<string, Set<() => void>>, key: string): void {
    const set = map.get(key);
    if (!set) return;
    for (const cb of set) cb();
  }
}

const Ctx = createContext<StreamingStore | null>(null);

interface StreamingProviderProps {
  children: ReactNode;
}

export function StreamingProvider({ children }: StreamingProviderProps) {
  const store = useMemo(() => new StreamingStore(), []);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/**
 * Stable no-op store for callers that render outside a `<StreamingProvider>`
 * (e.g. the onboarding synthetic-chat surface which reuses `<LeadMessage>`
 * purely for visuals). Returning a real store with empty state lets the
 * hook always call `useSyncExternalStore` unconditionally — keeping hook
 * order stable per React's rules — while making the partial/tool-input
 * reads no-ops outside the provider.
 */
const noopStore = new StreamingStore();

const noopUnsubscribe = (): void => {
  /* nothing to unsubscribe — null/empty key was never subscribed */
};

export function useStreamingPartial(
  messageId: string | null | undefined,
): StreamingPartial | undefined {
  const store = useContext(Ctx) ?? noopStore;
  return useSyncExternalStore(
    (cb) => (messageId ? store.subscribePartial(messageId, cb) : noopUnsubscribe),
    () => (messageId ? store.getPartial(messageId) : undefined),
    () => undefined,
  );
}

export function useStreamingToolInput(
  toolUseId: string | null | undefined,
): string | undefined {
  const store = useContext(Ctx) ?? noopStore;
  return useSyncExternalStore(
    (cb) => (toolUseId ? store.subscribeToolInput(toolUseId, cb) : noopUnsubscribe),
    () => (toolUseId ? store.getToolInput(toolUseId) : undefined),
    () => undefined,
  );
}

export function useStreamingDispatch(): StreamingDispatch {
  const store = useContext(Ctx);
  if (!store) {
    throw new Error('useStreamingDispatch called outside <StreamingProvider>');
  }
  return store;
}
