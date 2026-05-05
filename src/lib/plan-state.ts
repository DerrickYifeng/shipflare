/**
 * plan_items state machine.
 *
 * See spec §6 (docs/superpowers/specs/2026-04-20-planner-and-skills-redesign-design.md)
 * for the canonical diagram. This file encodes the transition map + a
 * single checked `transition()` function every writer must route through.
 *
 * The dispatcher, the weekly-replan worker, the stale-sweeper, the
 * API approve / skip endpoints, and any test fixture all call
 * `transition(item, toState)` — direct UPDATE statements that bypass
 * this file are a contract violation.
 *
 * Terminal states: `completed`, `skipped`, `failed`, `superseded`,
 * `stale`. Once an item lands in a terminal state the only legal next
 * state is itself (no-op) — transitions out of terminal throw.
 */

export type PlanItemState =
  | 'planned'
  | 'drafting'
  | 'drafted'
  | 'ready_for_review'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'superseded'
  | 'stale';

export type PlanItemUserAction = 'auto' | 'approve' | 'manual';

const TERMINAL_STATES: ReadonlySet<PlanItemState> = new Set([
  'completed',
  'skipped',
  'failed',
  'superseded',
  'stale',
]);

/**
 * Map of (from → set of allowed to) transitions.
 *
 * The `superseded` and `stale` branches apply from any non-terminal
 * state — they're enumerated in each row rather than special-cased at
 * the top so there's exactly one lookup site for validation.
 *
 * `skipped` is reachable from a handful of states because the API's
 * "skip this item" button can fire whether the item has been drafted,
 * is awaiting review, or was approved but not yet executed.
 */
const VALID_TRANSITIONS: ReadonlyMap<
  PlanItemState,
  ReadonlySet<PlanItemState>
> = new Map([
  [
    'planned',
    new Set<PlanItemState>([
      'drafting', // sweeper claims content_post for post_batch dispatch
      'drafted',
      'executing',
      'superseded',
      'stale',
      'skipped',
      'completed', // userAction=manual — founder marks "done" directly
      'failed', // fan-out draft errored before we could enter `drafted`
    ]),
  ],
  [
    // `drafting` — sweeper-claimed content_post awaiting the
    // content-manager(post_batch) team-run. The writer's `draft_post`
    // tool moves us to `drafted`; if the team-run errors before
    // persisting, the row drops to `failed` for retry.
    'drafting',
    new Set<PlanItemState>([
      'drafted',
      'failed',
      'superseded',
      'stale',
      'skipped',
    ]),
  ],
  [
    'drafted',
    new Set<PlanItemState>([
      'ready_for_review',
      'superseded',
      'failed',
      'skipped',
    ]),
  ],
  [
    'ready_for_review',
    new Set<PlanItemState>(['approved', 'skipped', 'superseded']),
  ],
  [
    'approved',
    new Set<PlanItemState>(['executing', 'superseded', 'skipped', 'stale']),
  ],
  [
    'executing',
    new Set<PlanItemState>(['completed', 'failed']),
  ],
  // Terminal states — only self-transition allowed. Enforced by
  // canTransition() hardcoding a rejection for any other target.
  ['completed', new Set<PlanItemState>([])],
  ['skipped', new Set<PlanItemState>([])],
  ['failed', new Set<PlanItemState>([])],
  ['superseded', new Set<PlanItemState>([])],
  ['stale', new Set<PlanItemState>([])],
]);

export function isTerminalState(state: PlanItemState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(
  from: PlanItemState,
  to: PlanItemState,
): boolean {
  if (from === to) return true; // idempotent
  if (isTerminalState(from)) return false;
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed ? allowed.has(to) : false;
}

/**
 * Narrow plan_item shape this module needs. Keeps the helper decoupled
 * from the drizzle row type so tests don't have to stand up a DB.
 */
export interface PlanItemLike {
  id: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly from: PlanItemState,
    public readonly to: PlanItemState,
  ) {
    super(`plan_item ${itemId}: invalid transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Produces the next-state for `item` after applying `to`. Throws
 * `InvalidTransitionError` when the transition isn't allowed. Does NOT
 * touch the DB — callers run the UPDATE themselves. The return value
 * is the post-transition `PlanItemLike`, suitable for optimistic
 * writes.
 */
export function transition<T extends PlanItemLike>(
  item: T,
  to: PlanItemState,
): T {
  if (!canTransition(item.state, to)) {
    throw new InvalidTransitionError(item.id, item.state, to);
  }
  return { ...item, state: to };
}

/**
 * Phase-transition helper for the plan-execute dispatcher. Given a
 * current state, returns which plan-execute `phase` (if any) the next
 * worker run should fire. Mirrors the spec §5.1 phase column:
 *
 * - `planned` + userAction='approve' → `draft` (produce output for review)
 * - `planned` + userAction='auto' → `execute` (skip review, run directly)
 * - `approved` → `execute` (user approved, run the side-effect skill)
 * - anything else → null (not ready to dispatch)
 */
export function nextDispatchPhase(
  state: PlanItemState,
  userAction: PlanItemUserAction,
): 'draft' | 'execute' | null {
  if (state === 'planned') {
    if (userAction === 'approve') return 'draft';
    if (userAction === 'auto') return 'execute';
    return null; // manual — dispatcher skips; user marks done directly
  }
  if (state === 'approved') return 'execute';
  return null;
}
