// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import {
  StreamingProvider,
  useStreamingPartial,
  useStreamingToolInput,
  useStreamingDispatch,
  type StreamingDispatch,
  type StreamingPartial,
} from '../streaming-context';

/**
 * Probe helpers: each test sets up a tiny tree containing zero or more
 * "probe" components that read a specific key, plus a Capture component
 * that stashes the dispatch into the closure for the outer assertion.
 * We deliberately avoid renderHook because we need multi-subscriber
 * render-count assertions.
 *
 * TODO(A2): integration test for `team-desk.tsx`'s `useStreamingPartialPipe`
 * — diffing `useTeamEvents` partials against a ref snapshot is the riskiest
 * new logic in A1, but the test belongs at the team-desk level (it depends
 * on EventSource + SSE wiring) and is out of scope for this module's tests.
 */

describe('StreamingProvider', () => {
  it('appendDelta notifies the matching subscriber exactly once', () => {
    let renderCountA = 0;
    let renderCountB = 0;

    function ProbeA() {
      useStreamingPartial('msg-a');
      renderCountA += 1;
      return null;
    }
    function ProbeB() {
      useStreamingPartial('msg-b');
      renderCountB += 1;
      return null;
    }

    let dispatch!: StreamingDispatch;
    function Capture() {
      dispatch = useStreamingDispatch();
      return null;
    }

    render(
      <StreamingProvider>
        <Capture />
        <ProbeA />
        <ProbeB />
      </StreamingProvider>,
    );

    const before = { a: renderCountA, b: renderCountB };
    act(() => {
      dispatch.appendDelta('msg-a', 'hello');
    });
    // Single-update semantics: exactly one re-render of the matching
    // subscriber, no fan-out. A buggy notify-too-often impl would push
    // this above before.a + 1.
    expect(renderCountA).toBe(before.a + 1);
    expect(renderCountB).toBe(before.b);
  });

  it('finalizePartial clears state and notifies subscriber', () => {
    let latest: StreamingPartial | undefined;
    let renderCount = 0;

    function Probe() {
      latest = useStreamingPartial('msg-a');
      renderCount += 1;
      return null;
    }

    let dispatch!: StreamingDispatch;
    function Capture() {
      dispatch = useStreamingDispatch();
      return null;
    }

    render(
      <StreamingProvider>
        <Capture />
        <Probe />
      </StreamingProvider>,
    );

    act(() => {
      dispatch.appendDelta('msg-a', 'hello');
    });
    expect(latest?.text).toBe('hello');
    const afterAppend = renderCount;

    act(() => {
      dispatch.finalizePartial('msg-a');
    });
    expect(latest).toBeUndefined();
    expect(renderCount).toBe(afterAppend + 1);
  });

  it('appendDelta after finalizePartial starts a fresh partial', () => {
    let latest: StreamingPartial | undefined;

    function Probe() {
      latest = useStreamingPartial('msg-a');
      return null;
    }

    let dispatch!: StreamingDispatch;
    function Capture() {
      dispatch = useStreamingDispatch();
      return null;
    }

    render(
      <StreamingProvider>
        <Capture />
        <Probe />
      </StreamingProvider>,
    );

    act(() => {
      dispatch.appendDelta('msg-a', 'first');
    });
    expect(latest?.text).toBe('first');

    act(() => {
      dispatch.finalizePartial('msg-a');
    });
    expect(latest).toBeUndefined();

    act(() => {
      dispatch.appendDelta('msg-a', 'second');
    });
    // Fresh partial — not 'firstsecond'. Mirrors the pipe's reconnect
    // replay path (`use-team-events.ts`'s `connected` branch wipes the
    // partials map mid-stream).
    expect(latest?.text).toBe('second');
  });

  it('partial and tool-input keyspaces are independent', () => {
    let partialRenders = 0;
    let toolInputRenders = 0;
    let latestPartial: StreamingPartial | undefined;
    let latestToolInput: string | undefined;

    function PartialProbe() {
      latestPartial = useStreamingPartial('shared-id');
      partialRenders += 1;
      return null;
    }
    function ToolInputProbe() {
      latestToolInput = useStreamingToolInput('shared-id');
      toolInputRenders += 1;
      return null;
    }

    let dispatch!: StreamingDispatch;
    function Capture() {
      dispatch = useStreamingDispatch();
      return null;
    }

    render(
      <StreamingProvider>
        <Capture />
        <PartialProbe />
        <ToolInputProbe />
      </StreamingProvider>,
    );

    const before = { p: partialRenders, t: toolInputRenders };

    // Writing to the partial keyspace must NOT notify the tool-input
    // subscriber, even though the key string is identical.
    act(() => {
      dispatch.appendDelta('shared-id', 'partial bytes');
    });
    expect(latestPartial?.text).toBe('partial bytes');
    expect(latestToolInput).toBeUndefined();
    expect(partialRenders).toBe(before.p + 1);
    expect(toolInputRenders).toBe(before.t);

    const afterPartial = { p: partialRenders, t: toolInputRenders };

    // Writing to the tool-input keyspace must NOT notify the partial
    // subscriber, and must NOT touch the partial's stored value.
    act(() => {
      dispatch.appendToolInput('shared-id', 'tool bytes');
    });
    expect(latestToolInput).toBe('tool bytes');
    expect(latestPartial?.text).toBe('partial bytes'); // unchanged
    expect(toolInputRenders).toBe(afterPartial.t + 1);
    expect(partialRenders).toBe(afterPartial.p);

    // And the finalizers stay in their own keyspaces too.
    act(() => {
      dispatch.finalizePartial('shared-id');
    });
    expect(latestPartial).toBeUndefined();
    expect(latestToolInput).toBe('tool bytes'); // still alive
  });
});
