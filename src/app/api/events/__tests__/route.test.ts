/**
 * Unit tests for `redactPubSubMessage` — the trust-boundary helper that
 * runs on every Redis pubsub message before it's forwarded to the
 * browser via SSE. Raw `tool_progress` envelopes carry internal tool
 * names (`xai_find_customers`, `add_plan_item`, etc.) which leak the
 * multi-agent architecture and AI vendor choices to any authenticated
 * client. This file pins the redaction contract.
 */
import { describe, it, expect, vi } from 'vitest';

// The route imports `@/lib/auth` (next-auth) and `@/lib/redis` (ioredis)
// at module-eval time. Neither is needed to test the pure `redactPubSubMessage`
// helper, so we stub them out to keep this a unit test that runs in
// vitest's default node env without next-auth's ESM resolution issues.
vi.mock('@/lib/auth', () => ({
  auth: async () => null,
}));
vi.mock('@/lib/redis', () => ({
  createPubSubSubscriber: () => ({}),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { redactPubSubMessage } from '../route';

describe('redactPubSubMessage', () => {
  it('redacts toolName in tool_progress events', () => {
    const input = JSON.stringify({
      type: 'tool_progress',
      toolName: 'xai_find_customers',
      callId: 'c1',
      message: 'searching X',
      metadata: { platform: 'x', queryCount: 3 },
      ts: 1234,
    });
    const out = redactPubSubMessage(input);
    const parsed = JSON.parse(out);
    expect(parsed.toolName).toBe('searching');
    expect(out).not.toContain('xai_find_customers');
  });

  it('redacts add_plan_item to planning', () => {
    const input = JSON.stringify({
      type: 'tool_progress',
      toolName: 'add_plan_item',
      callId: 'c2',
      message: 'added item',
      ts: 1234,
    });
    const out = redactPubSubMessage(input);
    expect(JSON.parse(out).toolName).toBe('planning');
  });

  it('passes through non-tool_progress events unchanged', () => {
    const input = JSON.stringify({ type: 'connected', channel: 'agents' });
    expect(redactPubSubMessage(input)).toBe(input);
  });

  it('passes through malformed JSON unchanged', () => {
    expect(redactPubSubMessage('not json')).toBe('not json');
  });

  it('passes through tool_progress without toolName field', () => {
    const input = JSON.stringify({ type: 'tool_progress', callId: 'c3', ts: 1234 });
    expect(redactPubSubMessage(input)).toBe(input);
  });

  it('preserves metadata fields (platform, mode, queryCount)', () => {
    // metadata.mode='calibrated' passes through as-is. This is a non-zero
    // IP signal but not a high-priority leak; can be addressed in a
    // follow-up if needed (the redactor would need a metadata-shape
    // allowlist similar to the team-events SSE).
    const input = JSON.stringify({
      type: 'tool_progress',
      toolName: 'find_threads_via_xai',
      callId: 'c4',
      metadata: { platform: 'x', mode: 'calibrated', queryCount: 5 },
      ts: 1234,
    });
    const parsed = JSON.parse(redactPubSubMessage(input));
    expect(parsed.toolName).toBe('searching');
    expect(parsed.metadata).toEqual({ platform: 'x', mode: 'calibrated', queryCount: 5 });
  });
});
