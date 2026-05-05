// Sanity export test for src/lib/limits.ts. Task 3 (2026-05-03 plan)
// hoisted the 4000-char tool-result truncation cap out of agent-run.ts
// so the activity-log renderer (and any future row-render path) can
// reference the same constant. A drift between the worker's truncation
// and the renderer's display would silently hide tool output, so we
// pin the value here as a tripwire — bumping it requires a deliberate
// test edit, not a one-line literal change.

import { describe, it, expect } from 'vitest';

import { TOOL_RESULT_TRUNCATION_LIMIT } from '@/lib/limits';

describe('lib/limits', () => {
  it('TOOL_RESULT_TRUNCATION_LIMIT exports 4000 chars', () => {
    expect(TOOL_RESULT_TRUNCATION_LIMIT).toBe(4000);
  });
});
