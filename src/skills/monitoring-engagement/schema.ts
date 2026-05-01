import { z } from 'zod';

/**
 * Output schema for the monitoring-engagement skill.
 * Assesses mentions and drafts responses for the engagement window.
 */
export const monitoringEngagementOutputSchema = z.object({
  mentions: z.array(
    z.object({
      mentionId: z.string(),
      authorUsername: z.string(),
      text: z.string(),
      shouldReply: z.boolean(),
      draftReply: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export type MonitoringEngagementOutput = z.infer<typeof monitoringEngagementOutputSchema>;
