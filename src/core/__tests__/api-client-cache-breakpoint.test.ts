import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { addMessageCacheBreakpoint } from '../api-client';

// Regression for the 2026-05-12 production crash:
//   agent-run failed: 400 { "error": { "type": "invalid_request_error",
//   "message": "messages.39.content.0.text: cache_control cannot be set
//   for empty text blocks" } }
// Anthropic rejects when cache_control lands on an empty text block.
// The upstream root cause was a spurious wake() pushing an empty
// userMessage at query-loop.ts:351-354; this defensive guard ensures
// addMessageCacheBreakpoint never produces the offending shape no matter
// what reaches it.
describe('addMessageCacheBreakpoint — empty text guard', () => {
  it('skips adding cache_control when last message has empty string content', () => {
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '' },
    ];
    const result = addMessageCacheBreakpoint(messages);
    expect(result).toHaveLength(3);
    const last = result[2]!;
    expect(last.content).toBe('');
  });

  it('skips adding cache_control when last block is an empty text block', () => {
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        content: [{ type: 'text', text: '' }],
      },
    ];
    const result = addMessageCacheBreakpoint(messages);
    const last = result[1]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Anthropic.Messages.TextBlockParam[];
    expect(blocks[0]!.text).toBe('');
    expect(
      (blocks[0]! as { cache_control?: unknown }).cache_control,
    ).toBeUndefined();
  });

  it('adds cache_control normally when last block has non-empty text', () => {
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'hello' },
    ];
    const result = addMessageCacheBreakpoint(messages);
    const last = result[0]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<
      Anthropic.Messages.TextBlockParam & {
        cache_control?: { type: 'ephemeral' };
      }
    >;
    expect(blocks[0]!.text).toBe('hello');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control to last block when message has multiple non-empty blocks', () => {
    const messages: Anthropic.Messages.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'preamble' },
          { type: 'text', text: 'final' },
        ],
      },
    ];
    const result = addMessageCacheBreakpoint(messages);
    const blocks = result[0]!.content as Array<
      Anthropic.Messages.TextBlockParam & {
        cache_control?: { type: 'ephemeral' };
      }
    >;
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns the empty array unchanged', () => {
    expect(addMessageCacheBreakpoint([])).toEqual([]);
  });
});
