import { describe, it, expect } from 'vitest';
import { loadSkill } from '@/core/skill-loader';
import { join } from 'node:path';

describe('slot-body skill', () => {
  it('loads without errors', () => {
    const skill = loadSkill(join(process.cwd(), 'src/skills/slot-body'));
    expect(skill.name).toBe('slot-body');
    expect(skill.cacheSafe).toBe(true);
  });
});
