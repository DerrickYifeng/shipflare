/**
 * validate_draft unit tests. The tool is pure (no DB / network) — runs the
 * shared content validators and packages the result with a repair prompt.
 */
import { describe, expect, it } from 'vitest';
import { validateDraftTool } from '../ValidateDraftTool';
import type { ToolContext } from '@/core/types';

const ctx = {} as unknown as ToolContext;

describe('validate_draft', () => {
  it('returns ok=true for a clean X reply', async () => {
    const result = await validateDraftTool.execute(
      {
        text: 'shipped 5 days ago. still tweaking the onboarding.',
        platform: 'x',
        kind: 'reply',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary).toBe('');
    expect(result.repairPrompt).toBe('');
  });

  it('returns ok=false with a repair prompt when a tweet is over 280 weighted chars', async () => {
    const result = await validateDraftTool.execute(
      {
        text: 'a'.repeat(281),
        platform: 'x',
        kind: 'reply',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].validator).toBe('length');
    expect(result.summary).toMatch(/too long/);
    expect(result.repairPrompt).toMatch(/281 characters/);
    expect(result.repairPrompt).toMatch(/280/);
  });

  it('weights URLs as t.co (23 chars)', async () => {
    const url = 'https://this-is-a-long-url.example.com/foo/bar';
    // 256 ASCII + 1 space + 23 URL = 280 weighted → ok
    const text = 'a'.repeat(256) + ' ' + url;
    const result = await validateDraftTool.execute(
      { text, platform: 'x', kind: 'reply' },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('strips leading @mentions when hasLeadingMentions=true', async () => {
    const text = '@alice @bob ' + 'a'.repeat(280);
    const result = await validateDraftTool.execute(
      {
        text,
        platform: 'x',
        kind: 'reply',
        hasLeadingMentions: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('validates each tweet of an X thread separately', async () => {
    const tweet1 = 'short hook.';
    const tooLong = 'a'.repeat(281);
    const result = await validateDraftTool.execute(
      {
        text: `${tweet1}\n\n${tooLong}`,
        platform: 'x',
        kind: 'post',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    const length = result.failures.find((f) => f.validator === 'length');
    expect(length).toBeDefined();
    if (length && length.validator === 'length') {
      expect(length.isThread).toBe(true);
      expect(length.segmentCount).toBe(2);
      expect(length.segments?.[1].ok).toBe(false);
    }
    expect(result.repairPrompt).toMatch(/tweet #2/);
  });

  it('reports warnings without failing ok (anchor token, hashtag count)', async () => {
    const result = await validateDraftTool.execute(
      {
        text: 'agreed completely.',
        platform: 'x',
        kind: 'reply',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    const anchor = result.warnings.find((w) => w.validator === 'anchor_token');
    expect(anchor).toBeDefined();
    // repairPrompt is non-empty because warnings exist even when ok=true
    expect(result.repairPrompt).not.toBe('');
  });

  it('rejects an unknown platform via input schema', async () => {
    const parsed = validateDraftTool.inputSchema.safeParse({
      text: 'hi',
      platform: 'linkedin',
      kind: 'post',
    });
    expect(parsed.success).toBe(false);
  });
});
