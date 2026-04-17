import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('calibrate-discovery.ts', () => {
  it('passes a single source per runSkill call', () => {
    const src = readFileSync('src/workers/processors/calibrate-discovery.ts', 'utf8');
    expect(src).toMatch(/for\s*\(\s*const\s+source\s+of\s+sources\s*\)/);
    expect(src).not.toMatch(/input:\s*\{[^}]*sources:\s*sources/);
  });
});
