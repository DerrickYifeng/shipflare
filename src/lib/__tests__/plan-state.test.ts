import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isTerminalState,
  nextDispatchPhase,
  transition,
  InvalidTransitionError,
  type PlanItemLike,
} from '../plan-state';

function item(
  state: PlanItemLike['state'],
  userAction: PlanItemLike['userAction'] = 'approve',
): PlanItemLike {
  return { id: 'test-1', state, userAction };
}

describe('isTerminalState', () => {
  it('returns true for every terminal state', () => {
    for (const s of ['completed', 'skipped', 'failed', 'superseded', 'stale'] as const) {
      expect(isTerminalState(s)).toBe(true);
    }
  });

  it('returns false for every non-terminal state', () => {
    for (const s of [
      'planned',
      'drafted',
      'ready_for_review',
      'approved',
      'executing',
    ] as const) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});

describe('canTransition — happy paths', () => {
  it('allows planned → drafted (approve flow)', () => {
    expect(canTransition('planned', 'drafted')).toBe(true);
  });
  it('allows planned → executing (auto flow)', () => {
    expect(canTransition('planned', 'executing')).toBe(true);
  });
  it('allows planned → completed (manual flow)', () => {
    expect(canTransition('planned', 'completed')).toBe(true);
  });
  it('allows drafted → ready_for_review', () => {
    expect(canTransition('drafted', 'ready_for_review')).toBe(true);
  });
  it('allows ready_for_review → approved', () => {
    expect(canTransition('ready_for_review', 'approved')).toBe(true);
  });
  it('allows ready_for_review → skipped', () => {
    expect(canTransition('ready_for_review', 'skipped')).toBe(true);
  });
  it('allows approved → executing', () => {
    expect(canTransition('approved', 'executing')).toBe(true);
  });
  it('allows executing → completed', () => {
    expect(canTransition('executing', 'completed')).toBe(true);
  });
  it('allows executing → failed', () => {
    expect(canTransition('executing', 'failed')).toBe(true);
  });
  it('allows self-transition for idempotency', () => {
    expect(canTransition('planned', 'planned')).toBe(true);
    expect(canTransition('completed', 'completed')).toBe(true);
  });
});

describe('canTransition — supersede / stale branches', () => {
  it('allows planned → superseded and planned → stale', () => {
    expect(canTransition('planned', 'superseded')).toBe(true);
    expect(canTransition('planned', 'stale')).toBe(true);
  });
  it('allows drafted → superseded', () => {
    expect(canTransition('drafted', 'superseded')).toBe(true);
  });
  it('allows ready_for_review → superseded', () => {
    expect(canTransition('ready_for_review', 'superseded')).toBe(true);
  });
  it('allows approved → superseded', () => {
    expect(canTransition('approved', 'superseded')).toBe(true);
  });
  it('does NOT allow executing → superseded (in-flight work is untouchable)', () => {
    expect(canTransition('executing', 'superseded')).toBe(false);
  });
});

describe('canTransition — rejects illegal moves', () => {
  it('rejects planned → approved (must draft first)', () => {
    expect(canTransition('planned', 'approved')).toBe(false);
  });
  it('rejects drafted → approved (must pass review first)', () => {
    expect(canTransition('drafted', 'approved')).toBe(false);
  });
  it('rejects ready_for_review → executing (must be approved first)', () => {
    expect(canTransition('ready_for_review', 'executing')).toBe(false);
  });
  it('rejects completed → any non-self state', () => {
    for (const to of [
      'planned',
      'drafted',
      'ready_for_review',
      'approved',
      'executing',
      'skipped',
    ] as const) {
      expect(canTransition('completed', to)).toBe(false);
    }
  });
  it('rejects superseded → any non-self state', () => {
    expect(canTransition('superseded', 'planned')).toBe(false);
    expect(canTransition('superseded', 'drafted')).toBe(false);
  });
});

describe('transition() function', () => {
  it('returns a new object with the updated state', () => {
    const src = item('planned');
    const next = transition(src, 'drafted');
    expect(next.state).toBe('drafted');
    expect(next).not.toBe(src); // not mutated
    expect(src.state).toBe('planned');
  });

  it('throws InvalidTransitionError on illegal move', () => {
    const src = item('planned');
    expect(() => transition(src, 'approved')).toThrow(InvalidTransitionError);
  });

  it('includes item id + from + to in the error', () => {
    const src = item('completed');
    try {
      transition(src, 'planned');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.itemId).toBe('test-1');
      expect(e.from).toBe('completed');
      expect(e.to).toBe('planned');
    }
  });

  it('preserves non-state fields', () => {
    const src = item('planned', 'auto');
    const next = transition(src, 'executing');
    expect(next.userAction).toBe('auto');
    expect(next.id).toBe('test-1');
  });
});

describe('nextDispatchPhase', () => {
  it('returns draft for planned+approve', () => {
    expect(nextDispatchPhase('planned', 'approve')).toBe('draft');
  });
  it('returns execute for planned+auto', () => {
    expect(nextDispatchPhase('planned', 'auto')).toBe('execute');
  });
  it('returns null for planned+manual (user finishes by marking completed)', () => {
    expect(nextDispatchPhase('planned', 'manual')).toBeNull();
  });
  it('returns execute for approved (any userAction)', () => {
    expect(nextDispatchPhase('approved', 'approve')).toBe('execute');
    expect(nextDispatchPhase('approved', 'auto')).toBe('execute');
  });
  it('returns null for drafted / ready_for_review (waiting on review/user)', () => {
    expect(nextDispatchPhase('drafted', 'approve')).toBeNull();
    expect(nextDispatchPhase('ready_for_review', 'approve')).toBeNull();
  });
  it('returns null for every terminal state', () => {
    for (const s of ['completed', 'skipped', 'failed', 'superseded', 'stale'] as const) {
      expect(nextDispatchPhase(s, 'approve')).toBeNull();
    }
  });
  it('returns null for executing (in-flight)', () => {
    expect(nextDispatchPhase('executing', 'approve')).toBeNull();
  });
});
