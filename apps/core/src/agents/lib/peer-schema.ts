import { z } from 'zod';

export const peerInputSchema = z.object({
	question: z.string().describe('What you want to ask them'),
	context: z.string().optional().describe('Background information they need'),
});
export type PeerInput = z.infer<typeof peerInputSchema>;

export const peerOutputSchema = z.object({
	answer: z.string().describe("The colleague's final response"),
	artifacts: z.array(z.record(z.string(), z.unknown())).optional().describe('Any structured outputs they produced'),
});
export type PeerOutput = z.infer<typeof peerOutputSchema>;
