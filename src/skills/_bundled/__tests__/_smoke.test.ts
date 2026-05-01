import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllSkills,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

describe('_bundled barrel side-effect import', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting('/nonexistent');
  });

  it('registers _bundled-smoke when the registry first runs', async () => {
    const all = await getAllSkills();
    const smoke = all.find((s) => s.name === '_bundled-smoke');
    expect(smoke).toBeDefined();
    expect(smoke!.source).toBe('bundled');
  });
});
