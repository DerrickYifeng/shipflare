// FindThreadsViaXaiTool.toTopQueued — extracted from the parent so the
// per-platform mapping (X surfaces likes/reposts; Reddit surfaces
// nulls) lives next to the candidate types and the parent file stays
// under the 800-line limit.

import type { JudgedCandidate } from './judge-candidate';

export interface FindThreadsViaXaiTopQueued {
  externalId: string;
  url: string;
  authorUsername: string;
  body: string;
  likesCount: number | null;
  repostsCount: number | null;
  confidence: number;
}

/**
 * Map one judged candidate into the FindThreadsViaXaiTopQueued shape
 * the StructuredOutput exposes to the coordinator.
 *
 * X path surfaces the actual likes/reposts engagement numbers.
 * Reddit path surfaces null engagement-stats — the `/today` UI doesn't
 * render Reddit threads through this same shape today (that wires in
 * with the Reddit-handoff Task 4); the numbers are kept null so no
 * caller renders an X-shaped engagement number for a Reddit thread by
 * accident.
 */
export function toTopQueued(
  j: JudgedCandidate,
): FindThreadsViaXaiTopQueued {
  if (j.candidate.platform === 'x') {
    return {
      externalId: j.candidate.row.external_id,
      url: j.candidate.row.url,
      authorUsername: j.candidate.row.author_username,
      body: j.candidate.row.body,
      likesCount: j.candidate.row.likes_count,
      repostsCount: j.candidate.row.reposts_count,
      confidence: j.verdict.score,
    };
  }
  return {
    externalId: j.candidate.row.external_id,
    url: j.candidate.row.url,
    authorUsername: j.candidate.row.author_username,
    body: j.candidate.row.body || j.candidate.row.title,
    likesCount: null,
    repostsCount: null,
    confidence: j.verdict.score,
  };
}
