import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('reply-drafter prompt contract', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/agents/reply-drafter.md'),
    'utf8',
  );

  it('references canMentionProduct flag', () => {
    expect(prompt).toMatch(/canMentionProduct/);
  });

  it('documents canMentionProduct=false as a hard suppress', () => {
    expect(prompt).toMatch(/canMentionProduct: false/);
    expect(prompt).toMatch(/do not mention the product/i);
  });

  it('lists only the six archetypes plus skip in the strategy enum', () => {
    const strategies = ['supportive_peer', 'data_add', 'contrarian', 'question_extender', 'anecdote', 'dry_wit', 'skip'];
    for (const s of strategies) expect(prompt).toContain(`\`${s}\``);
    // No old archetype names.
    for (const old of ['warm_congrats_question', 'tiny_data_point', 'dry_joke', 'proof_of_work']) {
      expect(prompt, `old archetype ${old} still present`).not.toContain(old);
    }
  });
});
