import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('calendar-plan.ts decoupling', () => {
  it('does not import enqueueMonitor or enqueueContentCalendar', () => {
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).not.toMatch(/enqueueMonitor\b/);
    expect(src).not.toMatch(/enqueueContentCalendar\b/);
  });

  it('imports enqueueCalendarSlotDraft', () => {
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).toMatch(/enqueueCalendarSlotDraft\b/);
  });
});
