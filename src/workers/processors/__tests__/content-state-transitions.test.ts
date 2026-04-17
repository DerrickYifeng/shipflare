import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('content.ts state transitions', () => {
  const src = readFileSync('src/workers/processors/content.ts', 'utf8');
  it('sets threads.state=drafting before runSkill', () => {
    expect(src).toMatch(/state:\s*'drafting'/);
  });
  it('sets threads.state=ready after draft insert', () => {
    expect(src).toMatch(/state:\s*'ready'/);
  });
  it('emits unified pipeline envelope on success', () => {
    expect(src).toMatch(/type:\s*'pipeline',\s*pipeline:\s*'reply'/);
  });
  it('sets threads.state=failed inside catch', () => {
    expect(src).toMatch(/state:\s*'failed'/);
  });
});
