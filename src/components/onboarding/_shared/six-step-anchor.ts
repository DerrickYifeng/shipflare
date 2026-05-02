// Pure mapping between `tool_progress` SSE events and the 6 conceptual UI
// steps in `SixStepAnimator`. Lives in its own file so the reducer can be
// unit-tested without React.
//
// The 6 steps in order (from `_copy.ts` stage6):
//   0 load     — Loading profile
//   1 match    — Matching state to plan shape
//   2 channels — Calibrating channels
//   3 subs     — Shortlisting subreddits
//   4 cadence  — Planning first-week cadence
//   5 review   — Adversarial QA on the plan
//
// The skill (`generating-strategy`) actually calls these tools internally:
//   - `query_recent_milestones` (early read — usually first)
//   - `query_strategic_path`    (optional — checks for a previous path)
//   - `query_metrics`           (optional — analytics)
//   - `write_strategic_path`    (terminal write)
//
// Anchors are MIN floors. If a later anchor fires before an earlier one
// (e.g. the skill skips `query_metrics`), the active step still advances.

export interface ToolProgressLike {
  readonly toolName: string;
  readonly phase: 'start' | 'done' | 'error';
}

export interface AnchorRule {
  readonly phase: 'start' | 'done' | 'error';
  readonly minActiveIndex: number;
}

/**
 * For each tool name, list the anchors keyed by phase. When the event fires,
 * `applyToolProgress` advances `activeIndex` to `Math.max(prev, minActiveIndex)`.
 *
 * `error` is treated like `done` so a failed query still moves the UI forward
 * (the skill has retry semantics; the route surfaces fatal failures via the
 * separate `error` SSE frame).
 */
export const TOOL_TO_STEP_ANCHORS: Record<string, readonly AnchorRule[]> = {
  query_recent_milestones: [
    { phase: 'start', minActiveIndex: 1 }, // load → done, match active
    { phase: 'done', minActiveIndex: 2 }, // load + match → done, channels active
    { phase: 'error', minActiveIndex: 2 },
  ],
  query_strategic_path: [
    { phase: 'start', minActiveIndex: 2 },
    { phase: 'done', minActiveIndex: 3 }, // channels → done, subs active
    { phase: 'error', minActiveIndex: 3 },
  ],
  query_metrics: [
    { phase: 'start', minActiveIndex: 3 },
    { phase: 'done', minActiveIndex: 4 }, // subs → done, cadence active
    { phase: 'error', minActiveIndex: 4 },
  ],
  write_strategic_path: [
    { phase: 'start', minActiveIndex: 5 }, // cadence → done, review active
    { phase: 'done', minActiveIndex: 6 }, // all 6 done
    { phase: 'error', minActiveIndex: 6 },
  ],
};

/**
 * Pure reducer: given the current `activeIndex` and an incoming tool_progress
 * event, return the new `activeIndex`. Never moves backward. Unknown tool
 * names + unmatched phases are no-ops (returns prev).
 */
export function applyToolProgress(
  prev: number,
  event: ToolProgressLike,
): number {
  const rules = TOOL_TO_STEP_ANCHORS[event.toolName];
  if (!rules) return prev;
  const match = rules.find((r) => r.phase === event.phase);
  if (!match) return prev;
  return Math.max(prev, match.minActiveIndex);
}
