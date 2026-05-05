import { describe, it, expect } from 'vitest';
import {
  parseRequirement,
  evaluateRequirement,
  evaluateAllRequirements,
  type TeamFacts,
} from '@/tools/AgentTool/requires-resolver';

describe('parseRequirement', () => {
  it('parses channel:x', () => {
    expect(parseRequirement('channel:x')).toEqual({
      kind: 'channel',
      value: 'x',
    });
  });

  it('parses product:has_description', () => {
    expect(parseRequirement('product:has_description')).toEqual({
      kind: 'product',
      value: 'has_description',
    });
  });

  it('throws on unknown prefix', () => {
    expect(() => parseRequirement('bogus:foo')).toThrow(
      /unknown.*prefix.*bogus/i,
    );
  });

  it('throws on missing colon', () => {
    expect(() => parseRequirement('channelx')).toThrow(/missing.*colon/i);
  });
});

describe('evaluateRequirement', () => {
  const facts: TeamFacts = {
    channels: new Set(['x', 'reddit']),
    productHasDescription: true,
  };

  it('channel:x → true when present', () => {
    expect(evaluateRequirement(parseRequirement('channel:x'), facts)).toBe(true);
  });

  it('channel:linkedin → false when absent', () => {
    expect(evaluateRequirement(parseRequirement('channel:linkedin'), facts)).toBe(
      false,
    );
  });

  it('product:has_description → true when set', () => {
    expect(
      evaluateRequirement(parseRequirement('product:has_description'), facts),
    ).toBe(true);
  });

  it('product:unknown_predicate → throws', () => {
    expect(() =>
      evaluateRequirement(parseRequirement('product:unknown_predicate'), facts),
    ).toThrow(/unknown.*product.*predicate/i);
  });
});

describe('evaluateAllRequirements', () => {
  const facts: TeamFacts = {
    channels: new Set(['x']),
    productHasDescription: true,
  };

  it('returns true when every requirement passes', () => {
    expect(
      evaluateAllRequirements(['channel:x', 'product:has_description'], facts),
    ).toBe(true);
  });

  it('returns false when any requirement fails', () => {
    expect(
      evaluateAllRequirements(['channel:x', 'channel:reddit'], facts),
    ).toBe(false);
  });

  it('returns true on empty requires list', () => {
    expect(evaluateAllRequirements([], facts)).toBe(true);
  });
});
