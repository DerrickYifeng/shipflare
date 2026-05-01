import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema } from '@/tools/SkillTool/schema';

describe('SkillFrontmatterSchema', () => {
  it('accepts a minimal valid frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'drafting-encouraging-replies',
      description: 'Drafts an encouraging X reply.',
    });
    expect(parsed.name).toBe('drafting-encouraging-replies');
    expect(parsed.context).toBeUndefined();
  });

  it('accepts a fully populated frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'judging-reply-opportunity',
      description: 'Decides whether a thread merits a reply.',
      context: 'fork',
      'allowed-tools': ['validate_draft'],
      model: 'claude-haiku-4-5',
      maxTurns: 4,
      'when-to-use': 'When discovery returns a thread.',
      'argument-hint': '<threadId>',
      paths: ['**/community-manager/**'],
    });
    expect(parsed.context).toBe('fork');
    expect(parsed['allowed-tools']).toEqual(['validate_draft']);
  });

  it('rejects names with uppercase', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'DraftingReplies',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects names exceeding 64 chars', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'a'.repeat(65),
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects reserved names anthropic / claude', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: 'anthropic', description: 'x' }),
    ).toThrow();
    expect(() =>
      SkillFrontmatterSchema.parse({ name: 'claude', description: 'x' }),
    ).toThrow();
  });

  it('rejects descriptions exceeding 1024 chars', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'a'.repeat(1025),
      }),
    ).toThrow();
  });

  it('rejects context values other than inline / fork', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        context: 'forked',
      }),
    ).toThrow();
  });

  it('passes through unknown fields (forwards-compat)', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      'future-cc-field': 'whatever',
    });
    expect((parsed as Record<string, unknown>)['future-cc-field']).toBe('whatever');
  });
});
