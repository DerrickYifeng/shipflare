'use client';

import { useCallback, useState } from 'react';

export interface NewSessionResult {
  /**
   * Client-only id with a `draft:` prefix. No `team_runs` row exists yet —
   * the composer's first send is what enqueues the real run and assigns its
   * server-generated runId. Consumers treat this as an opaque handle until
   * the draft is promoted.
   */
  draftId: string;
}

export interface UseNewSessionOptions {
  onCreated: (result: NewSessionResult) => void;
}

export interface UseNewSessionReturn {
  start: () => void;
  /** Kept for API compatibility with the old backend-round-trip variant. */
  creating: boolean;
}

/**
 * Opens a new "draft" session row entirely client-side. Clicking `+ New
 * session` used to POST `/api/team/run` with an empty goal, which made the
 * backend synthesize a neutral goal ("Review team state and propose next
 * actions for …") and kick off a coordinator run before the user had even
 * typed — so the user's first real brief ended up buried below an auto-
 * generated one.
 *
 * Now the button only spawns a local placeholder. The composer's first
 * send is what actually creates the team_run (with the user's message as
 * the goal), and the draft row is swapped out for the real session.
 */
export function useNewSession({
  onCreated,
}: UseNewSessionOptions): UseNewSessionReturn {
  const [creating] = useState(false);

  const start = useCallback(() => {
    const draftId = `draft:${crypto.randomUUID()}`;
    onCreated({ draftId });
  }, [onCreated]);

  return { start, creating };
}
