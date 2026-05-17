import { describe, it, expect } from 'vitest';
import { peerInputSchema, peerOutputSchema } from '../src/agents/lib/peer-schema';

describe('peer schemas', () => {
  it('peerInputSchema requires question, allows optional context', () => {
    expect(peerInputSchema.safeParse({ question: 'why?' }).success).toBe(true);
    expect(peerInputSchema.safeParse({ question: 'why?', context: 'because' }).success).toBe(true);
    expect(peerInputSchema.safeParse({ context: 'because' }).success).toBe(false);
  });

  it('peerOutputSchema requires answer, allows optional artifacts', () => {
    expect(peerOutputSchema.safeParse({ answer: 'ok' }).success).toBe(true);
    expect(peerOutputSchema.safeParse({ answer: 'ok', artifacts: [{ kind: 'draft' }] }).success).toBe(true);
    expect(peerOutputSchema.safeParse({ artifacts: [] }).success).toBe(false);
  });
});
