/**
 * SendMessage input-schema tests — engine-style flat-top + nested-union.
 *
 * Validates the `{to, summary?, message, run_id?}` top-level shape. `message`
 * is a `string | StructuredMessage` union; `StructuredMessage` is a discriminated
 * union of three protocol-response variants:
 *   - shutdown_request
 *   - shutdown_response
 *   - plan_approval_response
 *
 * Forbidden types (`task_notification`, `tick`) are system-only — they live
 * in the team_messages table but cannot be sent through the SendMessage tool.
 *
 * Anthropic-API invariant: serialized JSON Schema MUST NOT have a top-level
 * `anyOf` / `oneOf` / `allOf` (Anthropic rejects those). Nested unions inside
 * a property (here: `message`) ARE allowed. The agent-run smoke test enforces
 * the no-top-level-union invariant end-to-end without relying on the
 * `flattenTopLevelUnion` workaround.
 */
import { describe, it, expect, vi } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
// SendMessageTool.ts imports `wake` from `@/workers/processors/lib/wake`,
// which transitively pulls in BullMQ. Stub it so this schema-only test
// doesn't try to open a Redis connection.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: async () => {},
}));

import { SendMessageInputSchema } from '@/tools/SendMessageTool/SendMessageTool';

describe('SendMessage input schema — flat-top + nested-union', () => {
  describe('plain string message (DM or broadcast)', () => {
    it('accepts {to, message: string}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: 'Hello',
      });
      expect(parsed.to).toBe('researcher');
      expect(parsed.message).toBe('Hello');
    });

    it('accepts {to, summary, message: string}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        summary: '1-line preview',
        message: 'Hello',
      });
      expect(parsed.summary).toBe('1-line preview');
      expect(parsed.message).toBe('Hello');
    });

    it('accepts broadcast shape {to: "*", message: string}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: '*',
        message: 'Critical: stop all work',
      });
      expect(parsed.to).toBe('*');
      expect(parsed.message).toBe('Critical: stop all work');
    });

    it('rejects empty `to`', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: '',
          message: 'hi',
        }),
      ).toThrow();
    });

    it('rejects empty string `message`', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: 'researcher',
          message: '',
        }),
      ).toThrow();
    });
  });

  describe('structured: shutdown_request', () => {
    it('accepts {to, message: {type, reason?}}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: { type: 'shutdown_request', reason: 'wrap up' },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      expect(parsed.message.type).toBe('shutdown_request');
      if (parsed.message.type !== 'shutdown_request') throw new Error('narrow');
      expect(parsed.message.reason).toBe('wrap up');
    });

    it('accepts {to, message: {type}} (reason is optional)', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: { type: 'shutdown_request' },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      expect(parsed.message.type).toBe('shutdown_request');
    });
  });

  describe('structured: shutdown_response', () => {
    it('accepts {to, message: {type, request_id, approve: true}}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'msg-abc',
          approve: true,
        },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      if (parsed.message.type !== 'shutdown_response') throw new Error('narrow');
      expect(parsed.message.approve).toBe(true);
      expect(parsed.message.request_id).toBe('msg-abc');
    });

    it('accepts approve: false with reason', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'msg-abc',
          approve: false,
          reason: 'need 5 more minutes',
        },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      if (parsed.message.type !== 'shutdown_response') throw new Error('narrow');
      expect(parsed.message.reason).toBe('need 5 more minutes');
    });

    it('rejects shutdown_response with empty request_id', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: 'team-lead',
          message: {
            type: 'shutdown_response',
            request_id: '',
            approve: true,
          },
        }),
      ).toThrow();
    });
  });

  describe('structured: plan_approval_response', () => {
    it('accepts {to, message: {type, request_id, approve}}', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: {
          type: 'plan_approval_response',
          request_id: 'msg-xyz',
          approve: true,
        },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      if (parsed.message.type !== 'plan_approval_response')
        throw new Error('narrow');
      expect(parsed.message.approve).toBe(true);
    });

    it('accepts approve: false with feedback', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: {
          type: 'plan_approval_response',
          request_id: 'msg-xyz',
          approve: false,
          feedback: 'try a different angle',
        },
      });
      if (typeof parsed.message === 'string') throw new Error('narrowing');
      if (parsed.message.type !== 'plan_approval_response')
        throw new Error('narrow');
      expect(parsed.message.feedback).toBe('try a different angle');
    });
  });

  describe('forbidden / invalid message.type', () => {
    it('rejects message.type: task_notification (system-only)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: 'lead',
          message: {
            type: 'task_notification',
            content: '<task-notification>...</task-notification>',
          },
        }),
      ).toThrow();
    });

    it('rejects message.type: tick (system-only)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: 'lead',
          message: { type: 'tick' },
        }),
      ).toThrow();
    });

    it('rejects message.type: message (the plain-string form should be a bare string)', () => {
      expect(() =>
        SendMessageInputSchema.parse({
          to: 'researcher',
          message: { type: 'message', content: 'hi' },
        }),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Anthropic API compatibility — top-level shape
  // -------------------------------------------------------------------------
  //
  // Anthropic's tool input_schema grammar requires top-level type:'object'
  // and forbids top-level anyOf/oneOf/allOf. Nested unions inside a
  // property (here: `message`) are fine. This test asserts the shape
  // emerging from zod-to-json-schema directly, without the
  // flattenTopLevelUnion workaround — proving the engine-style schema is
  // natively Anthropic-compatible.

  describe('JSON Schema emission (Anthropic compatibility)', () => {
    it("emits top-level type: 'object' with no top-level anyOf/oneOf/allOf", () => {
      const schema = zodToJsonSchema(SendMessageInputSchema, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }) as Record<string, unknown>;

      expect(schema.type).toBe('object');
      expect(schema).not.toHaveProperty('anyOf');
      expect(schema).not.toHaveProperty('oneOf');
      expect(schema).not.toHaveProperty('allOf');

      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('to');
      expect(props).toHaveProperty('summary');
      expect(props).toHaveProperty('message');
      expect(props).toHaveProperty('run_id');

      // `message` IS allowed to carry a union (anyOf) — Anthropic only
      // forbids that at the top level.
      const messageProp = props.message as Record<string, unknown>;
      expect(messageProp).toHaveProperty('anyOf');
    });
  });
});
