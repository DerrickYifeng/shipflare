// Smoke registration — verifies that side-effect imports through
// src/skills/_bundled/index.ts reach the registry. Phase 1 ships no real
// bundled skills; this file is purely for the test in
// src/skills/_bundled/__tests__/_smoke.test.ts.
//
// Once Phase 2+ adds the first real bundled skill, this file may stay
// (cheap, harmless) or be deleted along with its test. Decision deferred.

import { registerBundledSkill } from '@/tools/SkillTool/registry';

registerBundledSkill({
  name: '_bundled-smoke',
  description: 'Phase 1 smoke skill — verifies bundled registration path. Internal.',
  context: 'inline',
  getPromptForCommand: () => 'BUNDLED SMOKE OK',
});
