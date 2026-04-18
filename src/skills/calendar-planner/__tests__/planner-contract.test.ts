import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('calendar-planner prompt contract', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/agents/calendar-planner.md'),
    'utf8',
  );
  const skill = readFileSync(
    join(process.cwd(), 'src/skills/calendar-planner/SKILL.md'),
    'utf8',
  );

  it('references the seven angles by name', () => {
    for (const angle of ['claim', 'story', 'contrarian', 'howto', 'data', 'case', 'synthesis']) {
      expect(prompt, `missing angle ${angle}`).toContain(angle);
    }
  });

  it('mentions thesisSource priority order', () => {
    expect(prompt).toMatch(/milestone/);
    expect(prompt).toMatch(/top_reply_ratio/);
    expect(prompt).toMatch(/fallback/);
  });

  it('requires whiteSpaceDayOffsets length 1 or 2', () => {
    expect(prompt).toMatch(/whiteSpaceDayOffsets[\s\S]*length 1 or 2|length[\s\S]*1[\s\S]*2/i);
  });

  it('skill declares the three new references', () => {
    expect(skill).toContain('x-angle-playbook.md');
    expect(skill).toContain('milestone-to-angles.md');
    expect(skill).toContain('fallback-modes.md');
  });
});
