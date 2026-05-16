import { z } from 'zod';

export const ACTIVITY_KINDS = [
  'turn_start',
  'turn_finish',
  'tool_call_start',
  'tool_call_finish',
  'subagent_dispatch',
  'subagent_finish',
  'subagent_text_delta',
  'subagent_tool_call_start',
  'subagent_tool_call_finish',
  'skill_invoke',
  'skill_finish',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const PayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn_start') }),
  z.object({
    kind: z.literal('turn_finish'),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tool_call_start'),
    tool: z.string(),
    argsPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('tool_call_finish'),
    tool: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('subagent_dispatch'),
    subAgent: z.string(),
    promptPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('subagent_finish'),
    subAgent: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
    summary: z.string().optional(),
  }),
  z.object({
    kind: z.literal('subagent_text_delta'),
    subAgent: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('subagent_tool_call_start'),
    subAgent: z.string(),
    tool: z.string(),
    argsPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('subagent_tool_call_finish'),
    subAgent: z.string(),
    tool: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('skill_invoke'),
    skill: z.string(),
    model: z.string().optional(),
    context: z.enum(['inline', 'fork']).optional(),
  }),
  z.object({
    kind: z.literal('skill_finish'),
    skill: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
]);

export const ActivityEventSchema = z.object({
  id: z.string(),
  createdAt: z.number().int().nonnegative(),
  conversationId: z.string().nullable(),
  parentTurnId: z.string().nullable(),
  runId: z.string().nullable(),
  sourceAgent: z.string(),
  parentEventId: z.string().nullable(),
  kind: z.enum(ACTIVITY_KINDS),
  payload: PayloadSchema,
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type ActivityPayload = z.infer<typeof PayloadSchema>;

export const ActivityEventInputSchema = ActivityEventSchema.omit({
  id: true,
  createdAt: true,
});
export type ActivityEventInput = z.infer<typeof ActivityEventInputSchema>;
