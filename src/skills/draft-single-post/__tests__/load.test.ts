import { describe, it, expect } from 'vitest';
import { loadSkill } from '@/core/skill-loader';
import { join } from 'node:path';

describe('draft-single-post skill', () => {
  it('loads without errors', () => {
    const skill = loadSkill(join(process.cwd(), 'src/skills/draft-single-post'));
    expect(skill.name).toBe('draft-single-post');
    expect(skill.cacheSafe).toBe(true);
  });
});
