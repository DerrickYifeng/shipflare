'use client';

import useSWR from 'swr';

/**
 * Shape returned by the hook — describes what the consuming button should
 * render. `reason` is optional hover-tooltip copy explaining *why* the button
 * is disabled; `label` overrides the button text when present (e.g. switching
 * "Generate Week" to "Queued…" while a plan job is in flight).
 */
export interface ServerTruthButtonState {
  disabled: boolean;
  label?: string;
  reason?: string;
}

/**
 * Narrow response shape expected from `GET /api/jobs/in-flight`. The endpoint
 * only needs to answer "is a job of this kind currently queued/active for
 * this user?"; the hook treats any 4xx/5xx as "not in flight" so we degrade
 * gracefully before the backend ships the route.
 */
interface JobsInFlightResponse {
  inFlight?: boolean;
}

async function fetchJobsInFlight(url: string): Promise<JobsInFlightResponse> {
  const res = await fetch(url);
  if (!res.ok) return { inFlight: false };
  return (await res.json()) as JobsInFlightResponse;
}

/**
 * Kinds of in-flight job we currently consult. The server route is
 * allow-listed rather than free-form so typos surface at compile time and we
 * don't accidentally start probing for job kinds that don't exist.
 */
export type ServerTruthJobKind = 'calendar-plan';

/**
 * Locally-derived signals the caller already holds. These are optional —
 * when omitted the hook falls back to pure server truth via the in-flight
 * endpoint. Supplying both signals gives the tightest UX because we can flip
 * the button the moment the user clicks (pending SWR revalidation) without
 * waiting on a network round-trip.
 */
export interface ServerTruthLocalSignals {
  /** Already-exists guard: flips the button to the "already done" label. */
  alreadyExists?: boolean;
  /** Copy for `alreadyExists=true`. Defaults to a generic "Already done". */
  alreadyExistsLabel?: string;
  /** Local "in flight" signal (e.g. SSE-driven isGenerating). OR'd with server truth. */
  localInFlight?: boolean;
  /** Copy while in flight. Defaults to "Queued…". */
  inFlightLabel?: string;
  /** Copy while in flight. Defaults to a neutral server-truth reason. */
  inFlightReason?: string;
  /** Copy when alreadyExists=true. Defaults to a neutral "already" reason. */
  alreadyExistsReason?: string;
}

export interface UseServerTruthButtonStateOptions {
  /**
   * Which job kind to poll on `/api/jobs/in-flight`. Omit when this particular
   * button does not have a server-job backing (e.g. a pure local-state gate).
   */
  kind?: ServerTruthJobKind;
  /** Local signals merged with server truth. See the type for semantics. */
  signals?: ServerTruthLocalSignals;
  /**
   * How often SWR should re-poll the in-flight endpoint. Defaults to 5s
   * while a local in-flight signal is true, otherwise 30s. Pass `0` to
   * disable polling entirely (e.g. in tests or when SSE drives freshness).
   */
  refreshIntervalMs?: number;
}

/**
 * Derive a button's disabled/label/reason from server truth plus optional
 * locally-held signals. Consumers should prefer this hook over ad-hoc
 * `useState(false)` for any button that kicks off a server-side job — local
 * state evaporates on unmount and lets the user double-trigger work.
 *
 * The hook returns a stable object shape regardless of loading state so
 * render code doesn't need null-checks. While SWR hydrates we default to
 * "not disabled" — the alternative (optimistic disable) would flash the
 * button grey on every page load.
 */
export function useServerTruthButtonState(
  options: UseServerTruthButtonStateOptions = {},
): ServerTruthButtonState {
  const { kind, signals = {}, refreshIntervalMs } = options;

  const swrKey = kind ? `/api/jobs/in-flight?kind=${kind}` : null;
  const { data } = useSWR<JobsInFlightResponse>(swrKey, fetchJobsInFlight, {
    refreshInterval:
      refreshIntervalMs ?? (signals.localInFlight ? 5_000 : 30_000),
    // In-flight is a best-effort ephemeral check — avoid thundering-herd
    // revalidation when the user focuses back to the tab.
    revalidateOnFocus: false,
  });

  const serverInFlight = data?.inFlight === true;
  const inFlight = serverInFlight || signals.localInFlight === true;

  if (signals.alreadyExists) {
    return {
      disabled: true,
      label: signals.alreadyExistsLabel ?? 'Already done',
      reason:
        signals.alreadyExistsReason ??
        'Already completed — no further action needed.',
    };
  }

  if (inFlight) {
    return {
      disabled: true,
      label: signals.inFlightLabel ?? 'Queued…',
      reason: signals.inFlightReason ?? 'Job is running — hang tight.',
    };
  }

  return { disabled: false };
}
