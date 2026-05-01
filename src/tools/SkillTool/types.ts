// Skill primitive — types ported from engine/commands.ts and adapted for
// ShipFlare's flat tool model. The `SkillCommand` shape mirrors CC's
// `Command & { type: 'prompt' }` but only includes fields ShipFlare honors.

import type { ToolContext } from '@/core/types';

/**
 * A loaded skill — either parsed from a SKILL.md file or registered
 * programmatically via registerBundledSkill().
 */
export interface SkillCommand {
  /** Always 'prompt' — distinguishes skills from MCP prompts in the future. */
  type: 'prompt';
  /** Skill identifier — matches frontmatter `name`. */
  name: string;
  /** Description visible to the model in SkillTool's roster. */
  description: string;
  /** Optional extra hint about when to invoke. */
  whenToUse?: string;
  /** Execution mode — defaults to 'inline'. */
  context: 'inline' | 'fork';
  /** Tool whitelist for fork mode. Inline mode inherits caller's tools. */
  allowedTools: string[];
  /** Model override (fork mode only). */
  model?: string;
  /** Turn budget for fork mode. */
  maxTurns?: number;
  /** Glob patterns scoping which agents may invoke this skill (parsed, not enforced in Phase 1). */
  paths?: string[];
  /** Argument format hint for the model. */
  argumentHint?: string;
  /** Source — 'file' for SKILL.md, 'bundled' for programmatic. */
  source: 'file' | 'bundled';
  /** Absolute path to SKILL.md file (file source only). */
  sourcePath?: string;
  /** Absolute path to the skill's root directory (file source only). */
  skillRoot?: string;
  /**
   * Renders the skill's prompt content. For file skills, returns the SKILL.md
   * body with $ARGUMENTS substituted. For bundled skills, runs the
   * registered closure.
   */
  getPromptForCommand(args: string, ctx: ToolContext): string | Promise<string>;
}
