/**
 * SendMessage discriminated-union schema tests — Phase C Task 1.
 *
 * Validates the 5-variant `discriminatedUnion('type', [...])` shape and the
 * backward-compatible preprocessor that injects `type: 'message'` for legacy
 * callers and renames the `message` field to `content`.
 *
 * Forbidden types (`task_notification`, `tick`) are system-only — they live
 * in the team_messages table but cannot be sent through the SendMessage tool.
 */
import { describe, it, expect, vi } from 'vitest';

// The schema's module imports `@/lib/db` (which calls postgres()) and
// `@/lib/redis` at top level. Stub them so the import doesn't try to open
// real connections during the test.
vi.mock('@/lib/db', () => ({
  db: {},
}));
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async () => 1,
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));
// Phase C Task 2: SendMessageTool.ts now imports `wake` from
// `@/workers/processors/lib/wake`, which transitively pulls in BullMQ. Stub
// it so this schema-only test doesn't try to open a Redis connection.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: async () => {},
}));

import { SendMessageInputSchema } from '@/tools/SendMessageTool/SendMessageTool';

describe('SendMessage discriminated union — Phase C', () => {
  describe('type: message (default)', () => {
    it('accepts {to, message} legacy shape (preprocessor defaults type)', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: 'Hello',
      });
      expect(parsed.type).toBe('message');
      if (parsed.type !== 'message') throw new Error('narrowing');
      expect(parsed.to).toBe('researcher');
      expect(parsed.content).toBe('Hello');
    });
    it('accepts explicit type:message form', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'message',
        to: 'researcher',
        content: 'Hello',
        summary: '1-line preview',
      });
      if (parsed.type !== 'message') throw new Error('narrowing');
      expect(parsed.summary).toBe('1-line preview');
    });
  });

  describe('type: broadcast', () => {
    it('accepts {type, content} (no to)', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'broadcast',
        content: 'Critical: stop all work',
      });
      expect(parsed.type).toBe('broadcast');
    });
    it('rejects broadcast with to field (broadcast has no recipient)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          type: 'broadcast',
          to: 'researcher',
          content: 'oops',
        }),
      ).toThrow();
    });
  });

  describe('type: shutdown_request', () => {
    it('accepts {type, to, content}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_request',
        to: 'researcher',
        content: 'wrap up',
      });
      expect(parsed.type).toBe('shutdown_request');
    });
  });

  describe('type: shutdown_response', () => {
    it('accepts {type, request_id, approve}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_response',
        request_id: 'msg-abc',
        approve: true,
      });
      if (parsed.type !== 'shutdown_response') throw new Error('narrowing');
      expect(parsed.approve).toBe(true);
    });
    it('accepts approve:false with content', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_response',
        request_id: 'msg-abc',
        approve: false,
        content: 'need 5 more minutes',
      });
      if (parsed.type !== 'shutdown_response') throw new Error('narrowing');
      expect(parsed.content).toBe('need 5 more minutes');
    });
  });

  describe('type: plan_approval_response', () => {
    it('accepts {type, request_id, to, approve}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'plan_approval_response',
        request_id: 'msg-xyz',
        to: 'researcher',
        approve: true,
      });
      if (parsed.type !== 'plan_approval_response')
        throw new Error('narrowing');
      expect(parsed.approve).toBe(true);
    });
  });

  describe('forbidden types not in schema', () => {
    it('rejects type: task_notification (system-only)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          type: 'task_notification',
          to: 'lead',
          content: '<task-notification>...</task-notification>',
        }),
      ).toThrow();
    });
    it('rejects type: tick (system-only)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          type: 'tick',
          to: 'lead',
          content: '...',
        }),
      ).toThrow();
    });
  });
});
