// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useTeamEvents } from '../use-team-events';

// ---------------------------------------------------------------------------
// Minimal EventSource mock — just enough surface for the hook under test.
// ---------------------------------------------------------------------------

type Listener = (evt: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: Listener | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(payload) }),
    );
  }
}

describe('useTeamEvents', () => {
  const OriginalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.instances.length = 0;
    // @ts-expect-error — test-only override of the browser global
    globalThis.EventSource = MockEventSource;
  });

  afterEach(() => {
    globalThis.EventSource = OriginalEventSource;
  });

  it('drains snapshot into the messages list in chronological order', () => {
    const { result } = renderHook(() =>
      useTeamEvents({ teamId: 'team-1' }),
    );

    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({
        type: 'snapshot',
        messageId: 'm-2',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'coord',
        to: null,
        messageType: 'agent_text',
        content: 'second',
        metadata: null,
        createdAt: '2026-04-20T00:00:10Z',
      });
      es.emit({
        type: 'snapshot',
        messageId: 'm-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'coord',
        to: null,
        messageType: 'agent_text',
        content: 'first',
        metadata: null,
        createdAt: '2026-04-20T00:00:00Z',
      });
      es.emit({ type: 'snapshot_end' });
    });

    // The hook inserts each appended message at its chronologically-sorted
    // position, so even when the server emits the snapshot in a different
    // order the list is ascending by createdAt.
    expect(result.current.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(result.current.isConnected).toBe(true);
  });

  it('dedupes an event that was already in the snapshot', () => {
    const { result } = renderHook(() =>
      useTeamEvents({ teamId: 'team-1' }),
    );
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({
        type: 'snapshot',
        messageId: 'm-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'coord',
        to: null,
        messageType: 'agent_text',
        content: 'first',
        metadata: null,
        createdAt: '2026-04-20T00:00:00Z',
      });
      es.emit({ type: 'snapshot_end' });
      // Same messageId as the snapshot — must NOT duplicate.
      es.emit({
        type: 'event',
        messageId: 'm-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'coord',
        to: null,
        content: 'first',
        createdAt: '2026-04-20T00:00:00Z',
      });
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it('respects the filter predicate', () => {
    const { result } = renderHook(() =>
      useTeamEvents({
        teamId: 'team-1',
        filter: (m) => m.from === 'wanted' || m.to === 'wanted',
      }),
    );
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({
        type: 'snapshot',
        messageId: 'm-keep',
        runId: null,
        teamId: 'team-1',
        from: 'wanted',
        to: null,
        messageType: 'agent_text',
        content: 'keep me',
        metadata: null,
        createdAt: '2026-04-20T00:00:00Z',
      });
      es.emit({
        type: 'snapshot',
        messageId: 'm-drop',
        runId: null,
        teamId: 'team-1',
        from: 'other',
        to: 'other-2',
        messageType: 'agent_text',
        content: 'drop me',
        metadata: null,
        createdAt: '2026-04-20T00:00:01Z',
      });
      es.emit({ type: 'snapshot_end' });
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['m-keep']);
  });

  it('accumulates agent_text deltas into a partial, then swaps in the final agent_text', () => {
    // Locks in the Phase 5 streaming contract: deltas accumulate into a
    // partial keyed by messageId, and the matching final `agent_text`
    // swaps it into the durable `messages` list. Phase A switched the
    // hook back to eager setState (React 18's concurrent scheduler
    // handles backpressure via the caller's `useDeferredValue`), so
    // the mid-stream partial content is observable synchronously
    // inside `act` — that's what this test locks in.
    const { result } = renderHook(() => useTeamEvents({ teamId: 'team-1' }));
    const es = MockEventSource.instances[0];

    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({ type: 'snapshot_end' });
      es.emit({
        type: 'event',
        messageType: 'agent_text_start',
        messageId: 'blk-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'mem-coord',
        to: null,
        content: null,
        createdAt: '2026-04-22T22:00:00.000Z',
      });
      es.emit({
        type: 'event',
        messageType: 'agent_text_delta',
        messageId: 'blk-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'mem-coord',
        to: null,
        content: 'hello',
        createdAt: '2026-04-22T22:00:00.050Z',
      });
      es.emit({
        type: 'event',
        messageType: 'agent_text_delta',
        messageId: 'blk-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'mem-coord',
        to: null,
        content: ' there',
        createdAt: '2026-04-22T22:00:00.100Z',
      });
    });

    // Mid-stream: partial has the accumulated text, messages list empty.
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.partials.size).toBe(1);
    expect(result.current.partials.get('blk-1')?.content).toBe('hello there');

    act(() => {
      es.emit({
        type: 'event',
        messageType: 'agent_text',
        messageId: 'blk-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: 'mem-coord',
        to: null,
        content: 'hello there',
        createdAt: '2026-04-22T22:00:00.150Z',
      });
    });

    // Final: partial dropped, durable agent_text appears exactly once.
    expect(result.current.partials.size).toBe(0);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('blk-1');
    expect(result.current.messages[0].type).toBe('agent_text');
    expect(result.current.messages[0].content).toBe('hello there');
  });

  it('appends a live user_prompt event with the correct message type', () => {
    // Regression: the SSE endpoint used to emit `{ type: 'event', ...parsed }`
    // which let the publish payload's own `type` key (e.g. 'user_prompt')
    // overwrite the wrapper. The switch in useTeamEvents only has a `case
    // 'event'` branch, so every live team message was silently dropped.
    // The endpoint now renames the inner type to `messageType` so the wrapper
    // survives — this test locks in both sides of the contract.
    const { result } = renderHook(() => useTeamEvents({ teamId: 'team-1' }));
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({ type: 'snapshot_end' });
      es.emit({
        type: 'event',
        messageType: 'user_prompt',
        messageId: 'user-msg-1',
        runId: 'run-1',
        teamId: 'team-1',
        from: null,
        to: null,
        content: 'hi team',
        metadata: null,
        createdAt: '2026-04-22T18:20:00Z',
      });
    });
    expect(result.current.messages).toHaveLength(1);
    const msg = result.current.messages[0];
    expect(msg.id).toBe('user-msg-1');
    expect(msg.type).toBe('user_prompt');
    expect(msg.content).toBe('hi team');
    expect(msg.runId).toBe('run-1');
  });

  it('inserts a live event with an earlier timestamp in chronological order', () => {
    const { result } = renderHook(() =>
      useTeamEvents({
        teamId: 'team-1',
        initialMessages: [
          {
            id: 'seed',
            runId: null,
            teamId: 'team-1',
            from: 'coord',
            to: null,
            type: 'agent_text',
            content: 'seeded',
            metadata: null,
            createdAt: '2026-04-20T00:00:30Z',
          },
        ],
      }),
    );
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit({ type: 'connected', teamId: 'team-1', runId: null });
      es.emit({ type: 'snapshot_end' });
      es.emit({
        type: 'event',
        messageId: 'earlier',
        runId: null,
        teamId: 'team-1',
        from: 'coord',
        to: null,
        content: 'retro',
        createdAt: '2026-04-20T00:00:00Z',
      });
    });
    expect(result.current.messages.map((m) => m.id)).toEqual([
      'earlier',
      'seed',
    ]);
  });

  it('treats a server-initiated reconnect as a controlled cycle', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useTeamEvents({ teamId: 'team-1' }),
      );
      const es = MockEventSource.instances[0];
      act(() => {
        es.emit({ type: 'connected', teamId: 'team-1', runId: null });
        es.emit({ type: 'snapshot_end' });
      });
      expect(result.current.isConnected).toBe(true);

      act(() => {
        es.emit({ type: 'reconnect' });
      });
      expect(result.current.isConnected).toBe(false);
      expect(result.current.reconnecting).toBe(true);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      // A second EventSource should have been constructed.
      expect(MockEventSource.instances.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
