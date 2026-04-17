import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('full-scan.ts fan-out shape', () => {
  it('fans out over sources via Promise.all', () => {
    const src = readFileSync('src/core/pipelines/full-scan.ts', 'utf8');
    expect(src).toMatch(/Promise\.all\(\s*sources\.map/);
  });
});
