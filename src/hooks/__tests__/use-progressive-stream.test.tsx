// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const listeners: Array<(data: unknown) => void> = [];
vi.mock('../use-sse-channel', () => ({
  useSSEChannel: (_: string, cb: (d: unknown) => void) => {
    listeners.push(cb);
  },
}));

import { useProgressiveStream } from '../use-progressive-stream';

const emit = (data: unknown) => {
  for (const cb of listeners) cb(data);
};

describe('useProgressiveStream', () => {
  beforeEach(() => {
    listeners.length = 0;
  });

  it('ignores events for other pipelines', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() =>
      emit({ type: 'pipeline', pipeline: 'reply', itemId: 'x', state: 'ready' }),
    );
    expect(result.current.items.size).toBe(0);
  });

  it('stores the latest state per itemId', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() =>
      emit({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'a',
        state: 'queued',
        seq: 1,
      }),
    );
    act(() =>
      emit({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'a',
        state: 'ready',
        seq: 2,
      }),
    );
    expect(result.current.items.get('a')?.state).toBe('ready');
  });

  it('drops stale (seq <= current)', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() =>
      emit({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'a',
        state: 'ready',
        seq: 5,
      }),
    );
    act(() =>
      emit({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'a',
        state: 'drafting',
        seq: 3,
      }),
    );
    expect(result.current.items.get('a')?.state).toBe('ready');
  });

  it('reset() sets the item back to queued', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() =>
      emit({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'a',
        state: 'failed',
        seq: 1,
      }),
    );
    act(() => result.current.reset('a'));
    expect(result.current.items.get('a')?.state).toBe('queued');
  });
});
