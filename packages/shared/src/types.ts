import { z } from "zod";

export const ConversationSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  title: z.string().nullable(),
  archived: z.boolean().default(false),
});

export const FounderMessageSchema = z.object({
  conversationId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  ts: z.number(),
  toolCallsJson: z.string().nullable(),
});

export const PlanItemSchema = z.object({
  id: z.string(),
  skill: z.string(),
  channel: z.enum(["x", "reddit"]),
  paramsJson: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
  ownerRole: z.string(),
  scheduledFor: z.number().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});

export type Conversation = z.infer<typeof ConversationSchema>;
export type FounderMessage = z.infer<typeof FounderMessageSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
