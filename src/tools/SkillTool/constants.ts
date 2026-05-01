import * as path from 'node:path';

/**
 * Canonical name for the skill invocation tool. Stable — agents reference
 * this in their AGENT.md `tools:` allowlist.
 */
export const SKILL_TOOL_NAME = 'skill';

/**
 * Default fork sub-agent turn budget when SKILL.md does not declare one.
 */
export const DEFAULT_SKILL_FORK_MAX_TURNS = 8;

/**
 * Filesystem root for project skills. Resolved against process.cwd() so that
 * worker startup (which uses cwd from a known repo root) finds the dir
 * without having to pass it in. Tests override via the loader's argument.
 */
export const SKILLS_ROOT = path.resolve(process.cwd(), 'src/skills');
