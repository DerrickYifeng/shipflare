// Port from engine/skills/loadSkillsDir.ts. Stripped:
// - Plugin / policy / managed source layers (only project skills in Phase 1)
// - Auto-memory hooks
// - MCP skill builders (registerMCPSkillBuilders)
// - Settings / permission rules
// - Lazy / memoized loaders (we use registry.ts cache instead)
// - Slash command tools whitelist parser (Phase 1 has no concept of disabled skills)
//
// Kept: filesystem walk, frontmatter parsing, SKILL.md → SkillCommand build.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@/lib/logger';
import { substituteArguments } from '@/utils/argumentSubstitution';
import { SkillFrontmatterSchema } from './schema';
import type { SkillCommand } from './types';
import type { ToolContext } from '@/core/types';
import { resolveReferenceFile, inlineReference } from '@/tools/AgentTool/loader';

const log = createLogger('tools:skill-loader');

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Skill-scoped YAML frontmatter parser for SKILL.md. Handles the subset of
 * YAML we use here: scalars, arrays-as-bullets, multi-line `|` / `|-` / `>`
 * block scalars, simple key:value pairs. Unknown keys pass through as strings.
 *
 * Deliberately separate from AgentTool's parser
 * (src/tools/AgentTool/loader.ts → splitFrontmatter + parseYamlFrontmatter).
 * That one is broader (strips unquoted trailing `#` comments, parses inline
 * `[a, b]` arrays, recognizes `null`/`~`, throws on unexpected indentation,
 * uses folded scalars) but doesn't support the `|` block scalars SKILL.md
 * uses. This one is narrower — line-leading `#` comments only, no inline
 * arrays, lenient on bad lines — but sufficient for the SKILL.md fields we
 * care about. Zero new deps; not extracted to a shared util on purpose.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };

  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split('\n');
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i += 1;
      continue;
    }
    const [, key, valueStart] = keyMatch;

    if (valueStart === '|' || valueStart === '|-' || valueStart === '>') {
      // Multi-line block scalar.
      const indented: string[] = [];
      i += 1;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln === '' || /^\s/.test(ln)) {
          indented.push(ln.replace(/^\s{2}/, ''));
          i += 1;
        } else {
          break;
        }
      }
      result[key] =
        valueStart === '>' ? indented.join(' ').trim() : indented.join('\n').trim();
      continue;
    }

    if (valueStart === '') {
      // Possibly a list of bullets on subsequent lines.
      const bullets: string[] = [];
      i += 1;
      while (i < lines.length) {
        const ln = lines[i];
        const bulletMatch = /^\s+-\s+(.+)$/.exec(ln);
        if (!bulletMatch) break;
        bullets.push(bulletMatch[1].trim());
        i += 1;
      }
      result[key] = bullets;
      continue;
    }

    // Plain scalar.
    let value: unknown = valueStart.trim();
    if (typeof value === 'string') {
      const v = value as string;
      if (/^-?\d+$/.test(v)) value = Number(v);
      else if (v === 'true') value = true;
      else if (v === 'false') value = false;
      else if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        value = v.slice(1, -1);
      }
    }
    result[key] = value;
    i += 1;
  }
  return { frontmatter: result, body };
}

/**
 * Load a single skill from a directory containing SKILL.md.
 * Returns null if no SKILL.md exists at the given path.
 * Throws if SKILL.md is present but malformed (missing required fields).
 */
export async function loadSkill(skillDir: string): Promise<SkillCommand | null> {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(skillMdPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  const validated = SkillFrontmatterSchema.parse(frontmatter);

  let inlinedBody = body;
  const refs = validated.references ?? [];
  for (const entry of refs) {
    let content: string;
    try {
      content = await resolveReferenceFile(skillDir, entry);
    } catch (err) {
      throw new Error(
        `Skill "${validated.name}" references missing file "${entry}" under ${path.join(
          skillDir,
          'references',
        )}: ${(err as Error).message}`,
      );
    }
    inlinedBody = inlineReference(inlinedBody, entry, content);
  }

  const cmd: SkillCommand = {
    type: 'prompt',
    name: validated.name,
    description: validated.description,
    whenToUse: validated['when-to-use'],
    context: validated.context ?? 'inline',
    allowedTools: validated['allowed-tools'] ?? [],
    model: validated.model,
    maxTurns: validated.maxTurns,
    paths: validated.paths,
    argumentHint: validated['argument-hint'],
    source: 'file',
    sourcePath: skillMdPath,
    skillRoot: skillDir,
    async getPromptForCommand(args: string, _ctx: ToolContext) {
      return substituteArguments(inlinedBody, args);
    },
  };
  return cmd;
}

/**
 * Walk `rootDir` and return every directory containing a SKILL.md.
 * Directories starting with "." are skipped to avoid scanning .git etc.
 */
async function discoverSkillDirs(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    let hasSkillMd = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        hasSkillMd = true;
        break;
      }
    }
    if (hasSkillMd) {
      results.push(current);
      // Don't recurse further — a skill's own subdirs (references/, etc.) are not other skills.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      stack.push(path.join(current, entry.name));
    }
  }
  return results.sort();
}

export async function loadSkillsDir(rootDir: string): Promise<SkillCommand[]> {
  const skillDirs = await discoverSkillDirs(rootDir);
  const loaded = await Promise.all(
    skillDirs.map(async (dir) => {
      try {
        return await loadSkill(dir);
      } catch (err) {
        // Per-skill failures are logged and skipped so one malformed
        // SKILL.md doesn't blackhole the whole roster. `loadSkill` itself
        // still throws when called directly so authoring errors surface.
        log.warn(
          `Failed to load skill at ${dir}: ${(err as Error).message}`,
        );
        return null;
      }
    }),
  );
  return loaded
    .filter((s): s is SkillCommand => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
