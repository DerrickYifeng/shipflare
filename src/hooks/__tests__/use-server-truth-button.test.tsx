// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { PropsWithChildren } from 'react';

import { useServerTruthButtonState } from '../use-server-truth-button';

/**
 * Wrap each test in a fresh SWRConfig so cached `/api/jobs/in-flight`
 * responses don't leak between cases. `dedupingInterval: 0` forces SWR to
 * actually re-run the fetcher instead of collapsing repeat calls.
 */
function wrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0 }}
    >
      {children}
    </SWRConfig>
  );
}

describe('useServerTruthButtonState', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // happy-dom ships fetch; we stub it per-test.
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns disabled=false when no signals or kind are supplied', () => {
    const { result } = renderHook(() => useServerTruthButtonState(), {
      wrapper,
    });
    expect(result.current).toEqual({ disabled: false });
    // No kind → no fetch should happen.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the already-done state when alreadyExists is true', () => {
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          signals: {
            alreadyExists: true,
            alreadyExistsLabel: 'Generated for this week',
          },
        }),
      { wrapper },
    );
    expect(result.current.disabled).toBe(true);
    expect(result.current.label).toBe('Generated for this week');
  });

  it('prefers alreadyExists over localInFlight', () => {
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          signals: {
            alreadyExists: true,
            alreadyExistsLabel: 'Done',
            localInFlight: true,
            inFlightLabel: 'Queued…',
          },
        }),
      { wrapper },
    );
    expect(result.current.label).toBe('Done');
  });

  it('returns the in-flight label when localInFlight is true', () => {
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          signals: {
            localInFlight: true,
            inFlightLabel: 'Queued…',
            inFlightReason: 'Plan running',
          },
          refreshIntervalMs: 0,
        }),
      { wrapper },
    );
    expect(result.current).toEqual({
      disabled: true,
      label: 'Queued…',
      reason: 'Plan running',
    });
  });

  it('disables based on server-truth inFlight response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ inFlight: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          kind: 'calendar-plan',
          refreshIntervalMs: 0,
        }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.disabled).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/jobs/in-flight?kind=calendar-plan',
    );
  });

  it('gracefully treats a 404 from the in-flight endpoint as not in flight', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          kind: 'calendar-plan',
          refreshIntervalMs: 0,
        }),
      { wrapper },
    );
    // Allow the SWR fetcher to resolve.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.disabled).toBe(false);
  });

  it('uses default copy when labels are not provided', () => {
    const { result } = renderHook(
      () =>
        useServerTruthButtonState({
          signals: { localInFlight: true },
          refreshIntervalMs: 0,
        }),
      { wrapper },
    );
    expect(result.current.label).toBe('Queued…');
    expect(result.current.reason).toBeDefined();
  });
});
