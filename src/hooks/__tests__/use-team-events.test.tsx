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
