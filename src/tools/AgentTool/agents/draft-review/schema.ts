import type { z } from 'zod';
import { draftReviewOutputSchema } from '@/agents/schemas';

export { draftReviewOutputSchema };
export type DraftReviewOutput = z.infer<typeof draftReviewOutputSchema>;
