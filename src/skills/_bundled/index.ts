// Barrel for bundled (programmatic TS) skills.
//
// Each ./<name>.ts file imports registerBundledSkill from
// '@/tools/SkillTool/registry' and registers itself at module load.
//
// Phase 1 ships no real bundled skills — this barrel is the wiring point
// that proves the registration path works end-to-end (verified by
// _bundled/_smoke.ts in Task 17).

// (intentionally empty in Phase 1)
export {};
