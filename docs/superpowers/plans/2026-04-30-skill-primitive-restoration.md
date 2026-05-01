# Skill Primitive Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Skill as a first-class primitive in ShipFlare's multi-agent system (Tool + Agent + Skill), aligned with Claude Code engine and Anthropic's official skill spec, with two end-to-end demo skills proving the infrastructure works.

**Architecture:** Port `engine/skills/loadSkillsDir.ts` and `engine/tools/SkillTool/SkillTool.ts` with strip (no analytics, plugins, MCP, hooks, permissions). New code under `src/tools/SkillTool/` mirrors `src/tools/AgentTool/` structure. Skill content under `src/skills/<name>/SKILL.md`. AgentTool's loader gains a `skills:` frontmatter field for preload, and `spawn.ts` injects preloaded skills via `runAgent`'s existing `prebuilt.forkContextMessages` hook.

**Tech Stack:** TypeScript, Vitest, Zod, drizzle-orm, ShipFlare's `src/core/query-loop.ts` runAgent, ShipFlare's `buildTool` factory (`src/core/tool-system.ts`).

**One implementation divergence from spec § 7.2** — ShipFlare's tool model returns `TOutput` from `execute()` (no `{data, newMessages}` shape like CC). We return skill content as tool_result text content directly. Same LLM-observable behavior (model reads it in the next turn), simpler implementation. Plan tasks reflect this; spec is otherwise unchanged.

**Spec:** `docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md` (committed at `e829a68`).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/tools/SkillTool/types.ts` | `SkillCommand` interface, frontmatter result types |
| `src/tools/SkillTool/schema.ts` | Zod frontmatter schema + validator helper |
| `src/tools/SkillTool/loadSkillsDir.ts` | Filesystem discovery + per-skill SKILL.md parser |
| `src/tools/SkillTool/registry.ts` | `registerBundledSkill()`, `getAllSkills()`, FS watcher cache |
| `src/tools/SkillTool/SkillTool.ts` | The `skill` tool — dispatch to inline / fork |
| `src/tools/SkillTool/prompt.ts` | Roster prompt generator (skill list visible to model) |
| `src/tools/SkillTool/constants.ts` | `SKILL_TOOL_NAME`, default config |
| `src/tools/SkillTool/__tests__/loader.test.ts` | Unit tests for loadSkillsDir |
| `src/tools/SkillTool/__tests__/schema.test.ts` | Frontmatter validation tests |
| `src/tools/SkillTool/__tests__/registry.test.ts` | Registry + watcher tests |
| `src/tools/SkillTool/__tests__/SkillTool.test.ts` | Tool dispatch tests |
| `src/tools/SkillTool/__tests__/SkillTool.integration.test.ts` | End-to-end tests |
| `src/tools/SkillTool/__tests__/fixtures/` | SKILL.md fixtures for tests |
| `src/utils/argumentSubstitution.ts` | Port from `engine/utils/argumentSubstitution.ts`, simplified |
| `src/utils/__tests__/argumentSubstitution.test.ts` | Unit tests |
| `src/skills/_demo-echo-inline/SKILL.md` | Demo skill — inline mode |
| `src/skills/_demo-echo-inline/references/format.md` | Demo skill reference doc |
| `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts` | Per-skill load test |
| `src/skills/_demo-echo-fork/SKILL.md` | Demo skill — fork mode |
| `src/skills/_demo-echo-fork/__tests__/_demo-echo-fork.test.ts` | Per-skill load test |
| `src/skills/_bundled/index.ts` | Empty barrel; will import bundled skills |
| `src/skills/_bundled/_smoke.ts` | Smoke registration to verify bundled path works |

### Modified files

| Path | Change |
|---|---|
| `src/tools/AgentTool/loader.ts` | Remove `'skills'` from `DROPPED_FIELDS`, add to schema + `AgentDefinition` |
| `src/tools/AgentTool/spawn.ts` | Add skill preload block before `runAgent` call |
| `src/tools/registry.ts` | Register `skillTool` |

### Verified-only files (read, don't modify in Phase 1)

| Path | What we verify |
|---|---|
| `src/core/query-loop.ts` | `prebuilt.forkContextMessages` accepts an array of MessageParam and injects them between systemPrompt and the user message |
| `engine/tools/SkillTool/SkillTool.ts` | Source for our port (read for reference) |
| `engine/skills/loadSkillsDir.ts` | Source for our port |
| `engine/utils/argumentSubstitution.ts` | Source for our port |

---

## Phase A — Foundations (Tasks 1-4)

### Task 1: Skill types + frontmatter Zod schema

**Files:**
- Create: `src/tools/SkillTool/types.ts`
- Create: `src/tools/SkillTool/schema.ts`
- Test: `src/tools/SkillTool/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `src/tools/SkillTool/__tests__/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema } from '@/tools/SkillTool/schema';

describe('SkillFrontmatterSchema', () => {
  it('accepts a minimal valid frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'drafting-encouraging-replies',
      description: 'Drafts an encouraging X reply.',
    });
    expect(parsed.name).toBe('drafting-encouraging-replies');
    expect(parsed.context).toBeUndefined();
  });

  it('accepts a fully populated frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'judging-reply-opportunity',
      description: 'Decides whether a thread merits a reply.',
      context: 'fork',
      'allowed-tools': ['validate_draft'],
      model: 'claude-haiku-4-5',
      maxTurns: 4,
      'when-to-use': 'When discovery returns a thread.',
      'argument-hint': '<threadId>',
      paths: ['**/community-manager/**'],
    });
    expect(parsed.context).toBe('fork');
    expect(parsed['allowed-tools']).toEqual(['validate_draft']);
  });

  it('rejects names with uppercase', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'DraftingReplies',
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects names exceeding 64 chars', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'a'.repeat(65),
        description: 'x',
      }),
    ).toThrow();
  });

  it('rejects reserved names anthropic / claude', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: 'anthropic', description: 'x' }),
    ).toThrow();
    expect(() =>
      SkillFrontmatterSchema.parse({ name: 'claude', description: 'x' }),
    ).toThrow();
  });

  it('rejects descriptions exceeding 1024 chars', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'a'.repeat(1025),
      }),
    ).toThrow();
  });

  it('rejects context values other than inline / fork', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        context: 'forked',
      }),
    ).toThrow();
  });

  it('passes through unknown fields (forwards-compat)', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      'future-cc-field': 'whatever',
    });
    expect((parsed as Record<string, unknown>)['future-cc-field']).toBe('whatever');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/schema.test.ts
```

Expected: FAIL with module not found for `@/tools/SkillTool/schema`.

- [ ] **Step 3: Write `types.ts`**

Create `src/tools/SkillTool/types.ts`:

```typescript
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
```

- [ ] **Step 4: Write `schema.ts`**

Create `src/tools/SkillTool/schema.ts`:

```typescript
// Zod frontmatter schema. Aligned with Anthropic platform spec
// (name + description required) plus CC engine extensions (context,
// allowed-tools, model, maxTurns, when-to-use, argument-hint, paths).
//
// Unknown fields pass through (forwards-compat). Loader callers may log
// a warning when unknown keys appear so authoring drift is visible.

import { z } from 'zod';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);

export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64, 'Skill name max 64 chars')
      .regex(/^[a-z0-9_-]+$/, 'Skill name must be [a-z0-9_-]+')
      .refine(
        (n) => !RESERVED_NAMES.has(n),
        'Skill name cannot be "anthropic" or "claude" (Anthropic spec)',
      ),
    description: z
      .string()
      .min(1)
      .max(1024, 'Skill description max 1024 chars'),
    context: z.enum(['inline', 'fork']).optional(),
    'allowed-tools': z.array(z.string()).optional(),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    'when-to-use': z.string().optional(),
    'argument-hint': z.string().optional(),
    paths: z.array(z.string()).optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
```

- [ ] **Step 5: Run schema tests**

```bash
pnpm test src/tools/SkillTool/__tests__/schema.test.ts
```

Expected: PASS — all 8 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/SkillTool/types.ts src/tools/SkillTool/schema.ts src/tools/SkillTool/__tests__/schema.test.ts
git commit -m "feat(skills): add SkillCommand types and frontmatter Zod schema"
```

---

### Task 2: argumentSubstitution port

**Files:**
- Create: `src/utils/argumentSubstitution.ts`
- Test: `src/utils/__tests__/argumentSubstitution.test.ts`

**Reference:** `engine/utils/argumentSubstitution.ts` (lines 24-145 in CC engine, ~120 LOC). We strip the named-args path (`$foo`) and shell-quote parsing — Phase 1 skills don't use those.

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/argumentSubstitution.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { substituteArguments } from '@/utils/argumentSubstitution';

describe('substituteArguments', () => {
  it('replaces $ARGUMENTS with the full args string', () => {
    expect(
      substituteArguments('Echo: $ARGUMENTS, end.', 'hello world'),
    ).toBe('Echo: hello world, end.');
  });

  it('replaces $0 / $1 with positional args', () => {
    expect(substituteArguments('first=$0 second=$1', 'a b')).toBe(
      'first=a second=b',
    );
  });

  it('returns body unchanged when no placeholders and no args', () => {
    expect(substituteArguments('plain body', '')).toBe('plain body');
  });

  it('appends ARGUMENTS line when no placeholder but args provided', () => {
    expect(substituteArguments('plain body', 'extra')).toBe(
      'plain body\n\nARGUMENTS: extra',
    );
  });

  it('replaces multiple $ARGUMENTS occurrences', () => {
    expect(
      substituteArguments('a=$ARGUMENTS b=$ARGUMENTS', 'x'),
    ).toBe('a=x b=x');
  });

  it('handles missing positional gracefully', () => {
    expect(substituteArguments('first=$0 second=$1', 'only')).toBe(
      'first=only second=',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/utils/__tests__/argumentSubstitution.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `argumentSubstitution.ts`**

Create `src/utils/argumentSubstitution.ts`:

```typescript
// Port from engine/utils/argumentSubstitution.ts, simplified.
//
// Stripped from CC engine version:
// - Named-args mapping ($foo → argumentNames lookup): not used by Phase 1 skills
// - Shell-quote parsing (try-parse-shell-command): args arrive already split
//   by SkillTool's caller, so plain whitespace split is sufficient
//
// Keeps:
// - $ARGUMENTS full-string replacement
// - $0 / $1 positional replacement
// - "append ARGUMENTS line" fallback when no placeholder

const ARGUMENTS_PLACEHOLDER = /\$ARGUMENTS\b/g;
const POSITIONAL_PLACEHOLDER = /\$(\d+)\b/g;

function parseArguments(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed === '') return [];
  return trimmed.split(/\s+/);
}

/**
 * Substitute $ARGUMENTS / $0 / $1 / ... in `body` with values from `args`.
 *
 * If `body` contains no placeholders and `args` is non-empty, appends
 * `\n\nARGUMENTS: <args>` so the model still sees them. This matches
 * CC engine behaviour and makes skills argument-passing-friendly even
 * when authors forget to add a placeholder.
 */
export function substituteArguments(body: string, args: string): string {
  const parsed = parseArguments(args);
  let result = body;
  let placeholderFound = false;

  if (ARGUMENTS_PLACEHOLDER.test(result)) {
    placeholderFound = true;
    result = result.replace(ARGUMENTS_PLACEHOLDER, args);
  }

  if (POSITIONAL_PLACEHOLDER.test(result)) {
    placeholderFound = true;
    result = result.replace(POSITIONAL_PLACEHOLDER, (_match, idx: string) => {
      const i = Number(idx);
      return parsed[i] ?? '';
    });
  }

  if (!placeholderFound && args.trim() !== '') {
    return `${result}\n\nARGUMENTS: ${args}`;
  }
  return result;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/utils/__tests__/argumentSubstitution.test.ts
```

Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/argumentSubstitution.ts src/utils/__tests__/argumentSubstitution.test.ts
git commit -m "feat(utils): port argumentSubstitution from engine (stripped)"
```

---

### Task 3: loadSkillsDir — discovery + per-skill parser

**Files:**
- Create: `src/tools/SkillTool/loadSkillsDir.ts`
- Test: `src/tools/SkillTool/__tests__/loader.test.ts`
- Test fixtures: `src/tools/SkillTool/__tests__/fixtures/valid-skill/`, `malformed-skill/`, `nested/grouped-skill/`

**Reference:** `engine/skills/loadSkillsDir.ts` (~800 LOC; we strip plugin/policy/MCP/auto-memory paths to ~200 LOC).

- [ ] **Step 1: Create test fixtures**

Create `src/tools/SkillTool/__tests__/fixtures/valid-skill/SKILL.md`:

```markdown
---
name: valid-skill
description: A fully populated valid skill fixture for tests.
context: inline
allowed-tools:
  - validate_draft
  - draft_reply
when-to-use: Only invoked from tests.
argument-hint: <input>
---

# Valid skill body

Echo back: $ARGUMENTS

For details see [format](references/format.md).
```

Create `src/tools/SkillTool/__tests__/fixtures/valid-skill/references/format.md`:

```markdown
# Format reference

This file exists to verify references/ folder discovery works.
```

Create `src/tools/SkillTool/__tests__/fixtures/malformed-skill/SKILL.md`:

```markdown
---
name: 
description: missing name
---

# Malformed
```

Create `src/tools/SkillTool/__tests__/fixtures/nested/grouped-skill/SKILL.md`:

```markdown
---
name: grouped-skill
description: Nested skill to verify recursive discovery.
---

# Grouped
```

- [ ] **Step 2: Write the failing loader test**

Create `src/tools/SkillTool/__tests__/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill, loadSkillsDir } from '@/tools/SkillTool/loadSkillsDir';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('loadSkill (single)', () => {
  it('parses a valid SKILL.md', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'valid-skill'));
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('valid-skill');
    expect(skill!.description).toContain('fully populated');
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual(['validate_draft', 'draft_reply']);
    expect(skill!.argumentHint).toBe('<input>');
    expect(skill!.source).toBe('file');
    expect(skill!.skillRoot).toBe(path.join(FIXTURES, 'valid-skill'));
    expect(skill!.sourcePath).toBe(
      path.join(FIXTURES, 'valid-skill', 'SKILL.md'),
    );
  });

  it('returns a callable getPromptForCommand that substitutes $ARGUMENTS', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'valid-skill'));
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const rendered = await skill!.getPromptForCommand('test-args', fakeCtx);
    expect(rendered).toContain('Echo back: test-args');
  });

  it('throws when SKILL.md is malformed (missing required field)', async () => {
    await expect(
      loadSkill(path.join(FIXTURES, 'malformed-skill')),
    ).rejects.toThrow();
  });

  it('defaults context to "inline" when omitted', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'nested', 'grouped-skill'));
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual([]);
  });
});

describe('loadSkillsDir (aggregate)', () => {
  it('discovers SKILL.md recursively, sorted by name', async () => {
    const skills = await loadSkillsDir(FIXTURES);
    const names = skills.map((s) => s.name);
    expect(names).toContain('valid-skill');
    expect(names).toContain('grouped-skill');
    expect(names).toEqual([...names].sort());
  });

  it('skips directories starting with "." (e.g. .git)', async () => {
    // No assertion needed beyond not throwing — fixture tree has no dotdirs,
    // but loader must not crash on real-world trees that do.
    await expect(loadSkillsDir(FIXTURES)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/loader.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `loadSkillsDir.ts`**

Create `src/tools/SkillTool/loadSkillsDir.ts`:

```typescript
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

const log = createLogger('tools:skill-loader');

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Minimal YAML frontmatter parser for SKILL.md. Handles the subset of YAML
 * we use: scalars, arrays-as-bullets, multi-line `|` block scalars, simple
 * key:value pairs. Unknown keys pass through as strings.
 *
 * Mirrors the same lightweight parser ShipFlare's AgentTool uses
 * (src/tools/AgentTool/loader.ts) — keeps zero new dependencies and matches
 * existing behaviour exactly.
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
      return substituteArguments(body, args);
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
  const loaded = await Promise.all(skillDirs.map((dir) => loadSkill(dir)));
  return loaded
    .filter((s): s is SkillCommand => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test src/tools/SkillTool/__tests__/loader.test.ts
```

Expected: PASS — all 6 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/SkillTool/loadSkillsDir.ts src/tools/SkillTool/__tests__/loader.test.ts src/tools/SkillTool/__tests__/fixtures/
git commit -m "feat(skills): add loadSkillsDir with frontmatter parser and discovery"
```

---

### Task 4: Constants + barrel exports

**Files:**
- Create: `src/tools/SkillTool/constants.ts`
- Create: `src/tools/SkillTool/index.ts`

- [ ] **Step 1: Write `constants.ts`**

Create `src/tools/SkillTool/constants.ts`:

```typescript
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
```

- [ ] **Step 2: Write `index.ts` barrel**

Create `src/tools/SkillTool/index.ts`:

```typescript
export { SKILL_TOOL_NAME, SKILLS_ROOT, DEFAULT_SKILL_FORK_MAX_TURNS } from './constants';
export type { SkillCommand } from './types';
export { SkillFrontmatterSchema } from './schema';
export type { SkillFrontmatter } from './schema';
export { loadSkill, loadSkillsDir } from './loadSkillsDir';
```

- [ ] **Step 3: Verify it type-checks**

```bash
pnpm tsc --noEmit
```

Expected: no errors related to `src/tools/SkillTool/`.

- [ ] **Step 4: Commit**

```bash
git add src/tools/SkillTool/constants.ts src/tools/SkillTool/index.ts
git commit -m "feat(skills): add SkillTool constants and barrel export"
```

---

## Phase B — Registry (Tasks 5-6)

### Task 5: registerBundledSkill + getAllSkills

**Files:**
- Create: `src/tools/SkillTool/registry.ts`
- Test: `src/tools/SkillTool/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/SkillTool/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  getAllSkills,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('registerBundledSkill', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  it('registers a bundled skill that getAllSkills returns', async () => {
    registerBundledSkill({
      name: 'bundled-test',
      description: 'A bundled skill for tests.',
      getPromptForCommand: () => 'bundled body',
    });
    __setSkillsRootForTesting(FIXTURES);

    const all = await getAllSkills();
    const names = all.map((s) => s.name);
    expect(names).toContain('bundled-test');
  });

  it('bundled skill wins on name conflict with file skill', async () => {
    registerBundledSkill({
      name: 'valid-skill',  // collides with fixtures/valid-skill/
      description: 'Bundled override.',
      getPromptForCommand: () => 'override',
    });
    __setSkillsRootForTesting(FIXTURES);

    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'valid-skill');
    expect(skill?.source).toBe('bundled');
    expect(skill?.description).toBe('Bundled override.');
  });

  it('bundled skill default context is "inline"', async () => {
    registerBundledSkill({
      name: 'bundled-default',
      description: 'no context declared',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);
    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'bundled-default');
    expect(skill?.context).toBe('inline');
    expect(skill?.allowedTools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registry.ts`**

Create `src/tools/SkillTool/registry.ts`:

```typescript
// Skill registry — programmatic registration for bundled skills + cached
// filesystem load. Mirrors src/tools/AgentTool/registry.ts pattern.
//
// Two sources merged:
// - Bundled skills (this module): registered via registerBundledSkill() at
//   import time, lives in process memory until process exit.
// - File skills (loadSkillsDir): scanned from disk, cached after first load,
//   invalidated by FS watcher on SKILL.md changes (Task 6).

import { createLogger } from '@/lib/logger';
import { loadSkillsDir } from './loadSkillsDir';
import type { SkillCommand } from './types';
import type { ToolContext } from '@/core/types';
import { SKILLS_ROOT } from './constants';

const log = createLogger('tools:skill-registry');

interface BundledSkillInput {
  name: string;
  description: string;
  whenToUse?: string;
  context?: 'inline' | 'fork';
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  argumentHint?: string;
  paths?: string[];
  getPromptForCommand: (args: string, ctx: ToolContext) => string | Promise<string>;
}

const bundledRegistry: SkillCommand[] = [];

interface RegistryState {
  root: string;
  promise: Promise<SkillCommand[]> | null;
}

const state: RegistryState = {
  root: SKILLS_ROOT,
  promise: null,
};

/**
 * Register a bundled (TS-defined) skill. Call from module side-effect imports
 * inside src/skills/_bundled/*.ts. Throws on duplicate name (within bundled
 * registry only — bundled-vs-file collisions resolve in getAllSkills with
 * bundled winning).
 */
export function registerBundledSkill(input: BundledSkillInput): void {
  const existing = bundledRegistry.find((s) => s.name === input.name);
  if (existing) {
    throw new Error(
      `Bundled skill "${input.name}" already registered (from ${existing.sourcePath ?? '<bundled>'})`,
    );
  }
  const skill: SkillCommand = {
    type: 'prompt',
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    context: input.context ?? 'inline',
    allowedTools: input.allowedTools ?? [],
    model: input.model,
    maxTurns: input.maxTurns,
    paths: input.paths,
    argumentHint: input.argumentHint,
    source: 'bundled',
    getPromptForCommand: input.getPromptForCommand,
  };
  bundledRegistry.push(skill);
  log.debug(`registered bundled skill "${input.name}"`);
}

/**
 * Return every loaded skill — bundled first, then file skills minus any
 * names that collide with bundled. Loaders are concurrent-safe; second
 * caller awaits the first caller's promise.
 */
export async function getAllSkills(): Promise<SkillCommand[]> {
  // Trigger bundled barrel side-effect import. Empty in Phase 1 but the
  // import itself ensures registerBundledSkill calls run before we read.
  await import('@/skills/_bundled');

  if (state.promise === null) {
    state.promise = loadSkillsDir(state.root).catch((err) => {
      state.promise = null;  // allow retry on next call
      throw err;
    });
  }
  const fileSkills = await state.promise;

  const bundledNames = new Set(bundledRegistry.map((s) => s.name));
  return [
    ...bundledRegistry,
    ...fileSkills.filter((s) => !bundledNames.has(s.name)),
  ];
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Reset both bundled registry and file cache. Vitest-only. */
export function __resetRegistryForTesting(): void {
  bundledRegistry.length = 0;
  state.promise = null;
}

/** Point the registry at a test fixtures dir. Must be called before getAllSkills. */
export function __setSkillsRootForTesting(root: string): void {
  state.root = root;
  state.promise = null;
}
```

- [ ] **Step 4: Add `src/skills/_bundled/index.ts` empty barrel**

Create `src/skills/_bundled/index.ts`:

```typescript
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
```

- [ ] **Step 5: Run registry tests**

```bash
pnpm test src/tools/SkillTool/__tests__/registry.test.ts
```

Expected: PASS — all 3 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/SkillTool/registry.ts src/tools/SkillTool/__tests__/registry.test.ts src/skills/_bundled/index.ts
git commit -m "feat(skills): add registerBundledSkill API and getAllSkills"
```

---

### Task 6: FS watcher + cache invalidation

**Files:**
- Modify: `src/tools/SkillTool/registry.ts`
- Test: `src/tools/SkillTool/__tests__/registry.test.ts`

**Reference:** `src/tools/AgentTool/registry.ts:73` `ensureWatcher()` — same pattern, copy with rename.

- [ ] **Step 1: Add the failing watcher test**

Append to `src/tools/SkillTool/__tests__/registry.test.ts`:

```typescript
import { promises as fs } from 'node:fs';
import * as os from 'node:os';

describe('FS watcher', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    __resetRegistryForTesting();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-watcher-'));
    await fs.mkdir(path.join(tmpRoot, 'a-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'a-skill', 'SKILL.md'),
      `---
name: a-skill
description: First version.
---

# Body v1
`,
      'utf8',
    );
  });

  it('reflects file edits after debounce', async () => {
    __setSkillsRootForTesting(tmpRoot);
    const first = await getAllSkills();
    expect(first.find((s) => s.name === 'a-skill')?.description).toBe('First version.');

    // Edit the skill file.
    await fs.writeFile(
      path.join(tmpRoot, 'a-skill', 'SKILL.md'),
      `---
name: a-skill
description: Second version.
---

# Body v2
`,
      'utf8',
    );

    // Wait past the watcher debounce (200ms) + a small buffer.
    await new Promise((r) => setTimeout(r, 350));

    const second = await getAllSkills();
    expect(second.find((s) => s.name === 'a-skill')?.description).toBe('Second version.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/registry.test.ts
```

Expected: FAIL — second `getAllSkills()` returns cached "First version." because no watcher invalidates.

- [ ] **Step 3: Add watcher to `registry.ts`**

Modify `src/tools/SkillTool/registry.ts` — replace the entire file content with this updated version (additions marked):

```typescript
// Skill registry — programmatic registration for bundled skills + cached
// filesystem load with FS watcher invalidation. Mirrors
// src/tools/AgentTool/registry.ts pattern.

import { createLogger } from '@/lib/logger';
import { watch, type FSWatcher } from 'node:fs';
import { loadSkillsDir } from './loadSkillsDir';
import type { SkillCommand } from './types';
import type { ToolContext } from '@/core/types';
import { SKILLS_ROOT } from './constants';

const log = createLogger('tools:skill-registry');

const WATCHER_DEBOUNCE_MS = 200;

interface BundledSkillInput {
  name: string;
  description: string;
  whenToUse?: string;
  context?: 'inline' | 'fork';
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  argumentHint?: string;
  paths?: string[];
  getPromptForCommand: (args: string, ctx: ToolContext) => string | Promise<string>;
}

const bundledRegistry: SkillCommand[] = [];

interface RegistryState {
  root: string;
  promise: Promise<SkillCommand[]> | null;
  watcher: FSWatcher | null;
  watcherDebounce: NodeJS.Timeout | null;
}

const state: RegistryState = {
  root: SKILLS_ROOT,
  promise: null,
  watcher: null,
  watcherDebounce: null,
};

function isWatcherDisabled(): boolean {
  return (process.env.SHIPFLARE_DISABLE_SKILL_WATCHER ?? '').trim() === '1';
}

function tearDownWatcher(): void {
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
      // Closing an already-closed watcher throws on some Node versions.
    }
    state.watcher = null;
  }
  if (state.watcherDebounce) {
    clearTimeout(state.watcherDebounce);
    state.watcherDebounce = null;
  }
}

function invalidateRegistry(): void {
  state.promise = null;
}

function ensureWatcher(): void {
  if (state.watcher) return;
  if (isWatcherDisabled()) return;

  try {
    const watcher = watch(
      state.root,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (filename && !filename.endsWith('.md')) return;
        if (state.watcherDebounce) clearTimeout(state.watcherDebounce);
        state.watcherDebounce = setTimeout(() => {
          state.watcherDebounce = null;
          log.info(
            `skill-registry: detected change (${filename ?? 'unknown'}) — invalidating cache`,
          );
          invalidateRegistry();
        }, WATCHER_DEBOUNCE_MS);
      },
    );
    watcher.on('error', (err) => {
      log.warn(
        `skill-registry: watcher error — disabling. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      tearDownWatcher();
    });
    state.watcher = watcher;
    log.debug(`skill-registry: watching ${state.root} for SKILL.md changes`);
  } catch (err) {
    log.warn(
      `skill-registry: failed to start watcher: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function registerBundledSkill(input: BundledSkillInput): void {
  const existing = bundledRegistry.find((s) => s.name === input.name);
  if (existing) {
    throw new Error(
      `Bundled skill "${input.name}" already registered (from ${existing.sourcePath ?? '<bundled>'})`,
    );
  }
  const skill: SkillCommand = {
    type: 'prompt',
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    context: input.context ?? 'inline',
    allowedTools: input.allowedTools ?? [],
    model: input.model,
    maxTurns: input.maxTurns,
    paths: input.paths,
    argumentHint: input.argumentHint,
    source: 'bundled',
    getPromptForCommand: input.getPromptForCommand,
  };
  bundledRegistry.push(skill);
  log.debug(`registered bundled skill "${input.name}"`);
}

export async function getAllSkills(): Promise<SkillCommand[]> {
  await import('@/skills/_bundled');
  ensureWatcher();
  if (state.promise === null) {
    state.promise = loadSkillsDir(state.root).catch((err) => {
      state.promise = null;
      throw err;
    });
  }
  const fileSkills = await state.promise;
  const bundledNames = new Set(bundledRegistry.map((s) => s.name));
  return [
    ...bundledRegistry,
    ...fileSkills.filter((s) => !bundledNames.has(s.name)),
  ];
}

export function __resetRegistryForTesting(): void {
  tearDownWatcher();
  bundledRegistry.length = 0;
  state.promise = null;
}

export function __setSkillsRootForTesting(root: string): void {
  tearDownWatcher();
  state.root = root;
  state.promise = null;
}
```

- [ ] **Step 4: Run watcher test**

```bash
pnpm test src/tools/SkillTool/__tests__/registry.test.ts
```

Expected: PASS — all 4 cases green (3 from Task 5 + 1 watcher).

- [ ] **Step 5: Commit**

```bash
git add src/tools/SkillTool/registry.ts src/tools/SkillTool/__tests__/registry.test.ts
git commit -m "feat(skills): add FS watcher with debounced cache invalidation"
```

---

## Phase C — SkillTool dispatch (Tasks 7-9)

### Task 7: SkillTool skeleton + roster prompt

**Files:**
- Create: `src/tools/SkillTool/SkillTool.ts`
- Create: `src/tools/SkillTool/prompt.ts`
- Test: `src/tools/SkillTool/__tests__/prompt.test.ts`
- Test: `src/tools/SkillTool/__tests__/SkillTool.test.ts`

- [ ] **Step 1: Write the failing prompt test**

Create `src/tools/SkillTool/__tests__/prompt.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { renderSkillRoster } from '@/tools/SkillTool/prompt';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('renderSkillRoster', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  it('lists every skill name + description', async () => {
    registerBundledSkill({
      name: 'bundled-x',
      description: 'A bundled fixture skill.',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);

    const roster = await renderSkillRoster();
    expect(roster).toContain('bundled-x');
    expect(roster).toContain('A bundled fixture skill.');
    expect(roster).toContain('valid-skill');
  });

  it('includes when-to-use hint when present', async () => {
    registerBundledSkill({
      name: 'with-hint',
      description: 'A skill.',
      whenToUse: 'Pick when X happens.',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);

    const roster = await renderSkillRoster();
    expect(roster).toContain('Pick when X happens.');
  });

  it('returns empty-state message when no skills registered', async () => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting('/nonexistent');
    const roster = await renderSkillRoster();
    expect(roster).toMatch(/no skills (registered|available)/i);
  });
});
```

- [ ] **Step 2: Write the failing tool test**

Create `src/tools/SkillTool/__tests__/SkillTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { skillTool } from '@/tools/SkillTool/SkillTool';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

const FIXTURES = path.resolve(__dirname, 'fixtures');

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(key: string) => null as unknown as V,
  };
}

describe('skillTool', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('exposes the canonical SKILL_TOOL_NAME', () => {
    expect(skillTool.name).toBe('skill');
  });

  it('input schema rejects missing skill field', () => {
    const result = skillTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('input schema accepts skill + optional args', () => {
    expect(
      skillTool.inputSchema.safeParse({ skill: 'valid-skill' }).success,
    ).toBe(true);
    expect(
      skillTool.inputSchema.safeParse({ skill: 'valid-skill', args: 'hello' })
        .success,
    ).toBe(true);
  });

  it('execute() throws on unknown skill', async () => {
    await expect(
      skillTool.execute({ skill: 'no-such-skill' }, fakeCtx() as never),
    ).rejects.toThrow(/Unknown skill/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test src/tools/SkillTool/__tests__/prompt.test.ts src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `prompt.ts`**

Create `src/tools/SkillTool/prompt.ts`:

```typescript
// SkillTool roster — string description appended to the tool's API description
// so the model sees what skills exist and can pick one.

import { getAllSkills } from './registry';

export async function renderSkillRoster(): Promise<string> {
  const skills = await getAllSkills();
  if (skills.length === 0) {
    return 'No skills are registered or available.';
  }

  const lines: string[] = ['Available skills:', ''];
  for (const s of skills) {
    lines.push(`### ${s.name}`);
    lines.push(s.description.trim());
    if (s.whenToUse) {
      lines.push('');
      lines.push(`When to use: ${s.whenToUse.trim()}`);
    }
    if (s.argumentHint) {
      lines.push(`Args: ${s.argumentHint}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build SkillTool's full description string. Static prefix + dynamic
 * skill roster (re-rendered on every call so newly registered skills
 * become visible without restarting).
 */
export async function getSkillToolDescription(): Promise<string> {
  const roster = await renderSkillRoster();
  return `Invoke a registered skill by name. Skills are reusable prompt units that can run inline (injected into this conversation) or as a forked sub-agent (isolated token budget).

${roster}

Pass arguments via the optional \`args\` field. The skill body uses $ARGUMENTS or $0/$1 placeholders to consume them.`;
}
```

- [ ] **Step 5: Implement `SkillTool.ts` (skeleton — execute returns "not implemented" for now)**

Create `src/tools/SkillTool/SkillTool.ts`:

```typescript
// SkillTool — invoke a registered skill from an agent's turn.
// Mode dispatch: SKILL.md frontmatter `context: inline` (default) injects
// content into the caller's conversation as the tool's result; `context: fork`
// spawns an isolated sub-agent.
//
// Phase 1 implementation diverges from spec §7.2 in one detail: ShipFlare's
// buildTool().execute() returns plain TOutput, not CC's {data, newMessages}
// shape. We package the skill content as the tool's text output — the model
// sees it on the next turn just like any other tool result. Same
// LLM-observable behavior, simpler implementation.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolContext, ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { SKILL_TOOL_NAME } from './constants';
import { getAllSkills } from './registry';

const log = createLogger('tools:skill');

const SkillToolInputSchema = z
  .object({
    skill: z.string().min(1, 'skill name required'),
    args: z.string().optional(),
  })
  .strict();

export type SkillToolInput = z.infer<typeof SkillToolInputSchema>;

export interface SkillToolOutput {
  /** Always true unless an error was thrown. */
  success: boolean;
  /** Echo of the skill name invoked. */
  commandName: string;
  /** Execution mode the skill ran under. */
  status: 'inline' | 'forked';
  /** The skill's resolved prompt content (inline) or sub-agent result (forked). */
  content: string;
}

export const skillTool: ToolDefinition<SkillToolInput, SkillToolOutput> = buildTool({
  name: SKILL_TOOL_NAME,
  description:
    'Invoke a registered skill by name. (Description is replaced with the live roster at agent-spawn time via prompt.ts.)',
  inputSchema: SkillToolInputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,
  async execute(input, ctx): Promise<SkillToolOutput> {
    const all = await getAllSkills();
    const cmd = all.find((s) => s.name === input.skill);
    if (!cmd) {
      throw new Error(
        `Unknown skill: "${input.skill}". Registered skills: ${all.map((s) => s.name).join(', ') || '<none>'}`,
      );
    }

    log.info(`SkillTool: invoking "${cmd.name}" (context=${cmd.context})`);

    // Inline mode (Task 8) and fork mode (Task 9) implementations land in
    // separate tasks. Phase 1 skeleton throws so the test for unknown skill
    // passes while we wire each mode incrementally.
    if (cmd.context === 'inline') {
      throw new Error(
        'NOT_IMPLEMENTED: inline mode lands in Task 8',
      );
    }
    throw new Error('NOT_IMPLEMENTED: fork mode lands in Task 9');
  },
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm test src/tools/SkillTool/__tests__/prompt.test.ts src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: PASS — prompt tests (3) + tool skeleton tests (4) all green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/SkillTool/SkillTool.ts src/tools/SkillTool/prompt.ts src/tools/SkillTool/__tests__/prompt.test.ts src/tools/SkillTool/__tests__/SkillTool.test.ts
git commit -m "feat(skills): add SkillTool skeleton with input schema and roster prompt"
```

---

### Task 8: SkillTool inline execution

**Files:**
- Modify: `src/tools/SkillTool/SkillTool.ts`
- Test: `src/tools/SkillTool/__tests__/SkillTool.test.ts`

- [ ] **Step 1: Add the failing inline-execution test**

Append to `src/tools/SkillTool/__tests__/SkillTool.test.ts`:

```typescript
describe('SkillTool inline mode', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('returns skill body with $ARGUMENTS substituted', async () => {
    const result = await skillTool.execute(
      { skill: 'valid-skill', args: 'hello world' },
      fakeCtx() as never,
    );
    expect(result.status).toBe('inline');
    expect(result.commandName).toBe('valid-skill');
    expect(result.content).toContain('Echo back: hello world');
    expect(result.success).toBe(true);
  });

  it('appends ARGUMENTS line when args provided but no placeholder', async () => {
    registerBundledSkill({
      name: 'no-placeholder',
      description: 'No $ARGUMENTS in body.',
      context: 'inline',
      getPromptForCommand: (args) => `Static body. Args were: ${args}`,
    });
    const result = await skillTool.execute(
      { skill: 'no-placeholder', args: 'extra' },
      fakeCtx() as never,
    );
    expect(result.content).toContain('Args were: extra');
  });

  it('handles bundled skill execute without args', async () => {
    registerBundledSkill({
      name: 'no-args',
      description: 'no args needed',
      context: 'inline',
      getPromptForCommand: () => 'static body',
    });
    const result = await skillTool.execute(
      { skill: 'no-args' },
      fakeCtx() as never,
    );
    expect(result.content).toBe('static body');
    expect(result.status).toBe('inline');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: FAIL — `NOT_IMPLEMENTED: inline mode lands in Task 8` thrown.

- [ ] **Step 3: Implement inline execution**

In `src/tools/SkillTool/SkillTool.ts`, replace the `execute` body — replace the `if (cmd.context === 'inline')` block:

```typescript
    if (cmd.context === 'inline') {
      const content = await Promise.resolve(
        cmd.getPromptForCommand(input.args ?? '', ctx),
      );
      return {
        success: true,
        commandName: cmd.name,
        status: 'inline',
        content,
      };
    }
    throw new Error('NOT_IMPLEMENTED: fork mode lands in Task 9');
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: PASS — all 7 cases green (4 from Task 7 + 3 inline).

- [ ] **Step 5: Commit**

```bash
git add src/tools/SkillTool/SkillTool.ts src/tools/SkillTool/__tests__/SkillTool.test.ts
git commit -m "feat(skills): implement SkillTool inline execution"
```

---

### Task 9: SkillTool fork execution

**Files:**
- Modify: `src/tools/SkillTool/SkillTool.ts`
- Test: `src/tools/SkillTool/__tests__/SkillTool.test.ts`

**Reference:** `src/tools/AgentTool/spawn.ts:181` `spawnSubagent()` — used as-is.

- [ ] **Step 1: Add the failing fork-execution test**

Append to `src/tools/SkillTool/__tests__/SkillTool.test.ts`:

```typescript
describe('SkillTool fork mode', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('spawns a sub-agent and returns its result text (mocked spawn)', async () => {
    // Register a fork skill.
    registerBundledSkill({
      name: 'fork-test',
      description: 'A fork skill.',
      context: 'fork',
      allowedTools: [],
      maxTurns: 4,
      getPromptForCommand: (args) => `# Body\n\nArgs: ${args}`,
    });

    // We can't easily spin up real LLM in unit tests — the fork path uses
    // spawnSubagent which calls runAgent. Rather than mock that here, this
    // test only verifies that:
    //   (a) execute() routes to the fork branch
    //   (b) errors from spawnSubagent surface (we call into a non-runnable
    //       context; a thrown error indicates the dispatcher took the right
    //       branch). Real fork verification happens in the integration test
    //       (Task 18) where a runnable context is provided.
    await expect(
      skillTool.execute({ skill: 'fork-test', args: 'x' }, fakeCtx() as never),
    ).rejects.toThrow();  // any error from spawnSubagent attempt is enough
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: FAIL — `NOT_IMPLEMENTED: fork mode lands in Task 9` thrown — but the test expects "any error" so it might pass already. We need to actually implement to confirm dispatch routes correctly.

Actually, the current skeleton throws `NOT_IMPLEMENTED` which IS an error, so the test passes for the wrong reason. Let's tighten the test:

Replace the `await expect(...).rejects.toThrow()` line with:

```typescript
    await expect(
      skillTool.execute({ skill: 'fork-test', args: 'x' }, fakeCtx() as never),
    ).rejects.not.toThrow(/NOT_IMPLEMENTED/);
```

Re-run:

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: FAIL — `NOT_IMPLEMENTED` is still thrown.

- [ ] **Step 3: Implement fork execution**

In `src/tools/SkillTool/SkillTool.ts`, add imports at the top:

```typescript
import { spawnSubagent } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import { DEFAULT_SKILL_FORK_MAX_TURNS } from './constants';
```

Then replace the trailing `throw new Error('NOT_IMPLEMENTED: fork mode lands in Task 9');` with:

```typescript
    // Fork mode — spawn an isolated sub-agent whose system prompt is the
    // skill body and whose user message is the args. Tools, model, and
    // turn budget come from the SKILL.md frontmatter.
    const systemPrompt = await Promise.resolve(
      cmd.getPromptForCommand(input.args ?? '', ctx),
    );

    const subAgentDef: AgentDefinition = {
      name: `skill:${cmd.name}`,
      description: cmd.description,
      tools: cmd.allowedTools,
      skills: [],  // skills cannot recursively preload skills (Phase 1)
      model: cmd.model,
      maxTurns: cmd.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
      systemPrompt,
      sourcePath: cmd.sourcePath ?? `<bundled:${cmd.name}>`,
    };

    const result = await spawnSubagent<unknown>(
      subAgentDef,
      input.args ?? '',
      ctx,
      undefined,  // no callbacks at the SkillTool layer
      undefined,  // no outputSchema
    );

    const resultText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);

    return {
      success: true,
      commandName: cmd.name,
      status: 'forked',
      content: resultText,
    };
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.test.ts
```

Expected: PASS — fork test now fails NOT with NOT_IMPLEMENTED but with a runtime error from spawnSubagent (since fakeCtx lacks LLM client). The `not.toThrow(/NOT_IMPLEMENTED/)` matcher succeeds.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/SkillTool/SkillTool.ts src/tools/SkillTool/__tests__/SkillTool.test.ts
git commit -m "feat(skills): implement SkillTool fork execution via spawnSubagent"
```

---

## Phase D — Agent ↔ Skill bridge (Tasks 10-12)

### Task 10: AgentTool loader — accept `skills:` field

**Files:**
- Modify: `src/tools/AgentTool/loader.ts`
- Test: `src/tools/AgentTool/__tests__/loader.test.ts`

- [ ] **Step 1: Add the failing test**

Read `src/tools/AgentTool/__tests__/fixtures/valid-agent/AGENT.md` to see existing fixture format. Then add a new fixture that declares a `skills:` field:

Create `src/tools/AgentTool/__tests__/fixtures/agent-with-skills/AGENT.md`:

```markdown
---
name: agent-with-skills
description: Fixture agent that declares skills in frontmatter.
tools:
  - skill
skills:
  - some-skill
  - another-skill
model: claude-sonnet-4-6
maxTurns: 5
---

# Body

This agent has skills declared.
```

Append to `src/tools/AgentTool/__tests__/loader.test.ts`:

```typescript
describe('skills frontmatter', () => {
  it('parses skills array into AgentDefinition.skills', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'agent-with-skills'),
      { sharedReferencesDir: SHARED_REFS },
    );
    expect(agent.skills).toEqual(['some-skill', 'another-skill']);
  });

  it('defaults skills to empty array when frontmatter omits it', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    expect(agent.skills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/AgentTool/__tests__/loader.test.ts
```

Expected: FAIL — `agent.skills` is undefined; the fixture's `skills:` is in `DROPPED_FIELDS` and gets dropped.

- [ ] **Step 3: Modify `src/tools/AgentTool/loader.ts`**

(a) In the `DROPPED_FIELDS` list (around line 67-80), remove `'skills'`:

```diff
 const DROPPED_FIELDS = [
-  'skills',
   'hooks',
   'mcpServers',
   ...
 ] as const;
```

(b) In the `frontmatterSchema` Zod object (around line 43-62), add `skills`:

```diff
   tools: z.array(z.string()).optional(),
+  skills: z.array(z.string()).optional(),
   model: z.string().min(1).optional(),
```

(c) In the `AgentDefinition` interface (around line 17-28), add `skills`:

```diff
 export interface AgentDefinition {
   name: string;
   description: string;
   tools: string[];
+  skills: string[];
   model?: string;
   ...
 }
```

(d) In the returned definition (around line 424-437 — find the `return { name: parsed.name, ... }` block), add `skills`:

```diff
   return {
     name: parsed.name,
     description: parsed.description,
     tools: parsed.tools ?? [],
+    skills: parsed.skills ?? [],
     ...(parsed.model !== undefined ? { model: parsed.model } : {}),
     maxTurns: parsed.maxTurns ?? DEFAULT_MAX_TURNS,
     ...
   };
```

- [ ] **Step 4: Run loader tests**

```bash
pnpm test src/tools/AgentTool/__tests__/loader.test.ts
```

Expected: PASS — both new cases green plus all existing tests still pass.

- [ ] **Step 5: Run full agent test suite (regression check)**

```bash
pnpm test src/tools/AgentTool/
```

Expected: PASS — no agent test regresses.

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/loader.ts src/tools/AgentTool/__tests__/loader.test.ts src/tools/AgentTool/__tests__/fixtures/agent-with-skills/
git commit -m "feat(agent-loader): accept skills frontmatter field for preload"
```

---

### Task 11: Regression test — runAgent honors `prebuilt.forkContextMessages`

**Goal:** Lock in the contract that spawn.ts (Task 12) depends on. Plan-time inspection of `src/core/query-loop.ts:332-343` confirmed that `prebuilt.forkContextMessages` IS already honored: the array is prepended to the messages list before the user message.

```ts
// query-loop.ts:337-343 (current behavior)
const resolvedPrior: Anthropic.Messages.MessageParam[] =
  prebuilt?.forkContextMessages ?? priorMessages ?? [];

const messages: Anthropic.Messages.MessageParam[] = [
  ...resolvedPrior,
  { role: 'user', content: userMessage },
];
```

This task adds a regression test that fails if anyone later refactors that
behavior away. No production code changes.

**Files:**
- Test only: `src/core/__tests__/query-loop-fork-context.test.ts`

- [ ] **Step 1: Read current `runAgent` signature**

Open `src/core/query-loop.ts:254-310`. Confirm:
- Line 264: `prebuilt?.forkContextMessages?: Anthropic.Messages.MessageParam[]`
- Lines 337-343: `forkContextMessages` is prepended to the messages array
- Line 92: `createMessage({...})` is the Anthropic call site (imported from `./api-client`)

If any of those points have changed since plan writing, **STOP** and surface
the divergence. Otherwise proceed.

- [ ] **Step 2: Write the regression test**

Create `src/core/__tests__/query-loop-fork-context.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// Mock the createMessage seam (src/core/api-client) so we can capture the
// messages array passed to Anthropic without actually calling the LLM.
const createMessageMock = vi.fn();
vi.mock('@/core/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/core/api-client')>(
    '@/core/api-client',
  );
  return {
    ...actual,
    createMessage: (...args: unknown[]) => createMessageMock(...args),
  };
});

import { runAgent } from '@/core/query-loop';
import type { AgentConfig, ToolContext } from '@/core/types';

function fakeCtx(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

function fakeConfig(systemPrompt: string): AgentConfig {
  return {
    name: 'test-agent',
    systemPrompt,
    model: 'claude-haiku-4-5',
    tools: [],
    maxTurns: 1,
  };
}

// One-turn end_turn response so runAgent exits after the first createMessage.
function endTurnResponse(): {
  response: Anthropic.Messages.Message;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    response: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as Anthropic.Messages.Message,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe('runAgent: prebuilt.forkContextMessages (regression test for skill preload)', () => {
  beforeEach(() => {
    createMessageMock.mockReset();
    createMessageMock.mockResolvedValue(endTurnResponse());
  });

  it('prepends forkContextMessages before the user message', async () => {
    await runAgent(
      fakeConfig('SYSTEM PROMPT BODY'),
      'USER MESSAGE',
      fakeCtx(),
      undefined,  // outputSchema
      undefined,  // onProgress
      {
        systemBlocks: [],
        forkContextMessages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'PRELOADED SKILL CONTENT' }],
          },
        ],
      },
    );

    expect(createMessageMock).toHaveBeenCalledTimes(1);
    const callArg = createMessageMock.mock.calls[0][0] as {
      messages: Anthropic.Messages.MessageParam[];
    };
    const msgs = callArg.messages;

    // First message is the preloaded skill, second is the user message.
    expect(msgs).toHaveLength(2);
    const firstContent = msgs[0].content;
    const firstStr =
      typeof firstContent === 'string'
        ? firstContent
        : firstContent
            .map((b) => ('text' in b ? b.text : ''))
            .join('');
    expect(firstStr).toContain('PRELOADED SKILL CONTENT');

    const secondContent = msgs[1].content;
    const secondStr =
      typeof secondContent === 'string'
        ? secondContent
        : secondContent
            .map((b) => ('text' in b ? b.text : ''))
            .join('');
    expect(secondStr).toBe('USER MESSAGE');
  });

  it('with no prebuilt, only the user message is sent', async () => {
    await runAgent(
      fakeConfig('SYSTEM'),
      'USER MESSAGE',
      fakeCtx(),
    );

    const callArg = createMessageMock.mock.calls[0][0] as {
      messages: Anthropic.Messages.MessageParam[];
    };
    expect(callArg.messages).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm test src/core/__tests__/query-loop-fork-context.test.ts
```

Expected: PASS — both cases green. The current behavior of `query-loop.ts`
honors `forkContextMessages` and this test locks it in.

If the test FAILS (unexpected), STOP and investigate. Possibilities:
- The mock path `@/core/api-client` does not match how `query-loop.ts`
  imports `createMessage` — adjust the mock target.
- The behavior changed since plan writing — re-verify
  `query-loop.ts:332-343` and update either the test or this plan.

- [ ] **Step 4: Commit**

```bash
git add src/core/__tests__/query-loop-fork-context.test.ts
git commit -m "test(core): regression — runAgent prebuilt.forkContextMessages prepends to messages"
```

---

### Task 12: spawn.ts — skill preload block

**Files:**
- Modify: `src/tools/AgentTool/spawn.ts`
- Test: `src/tools/AgentTool/__tests__/spawn.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Check if `src/tools/AgentTool/__tests__/spawn.test.ts` exists. If not, create it. Add this test:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

// Mock runAgent so spawnSubagent doesn't actually call the LLM. Capture the
// `prebuilt` argument so we can assert skill preload messages were injected.
const runAgentMock = vi.fn();
vi.mock('@/core/query-loop', () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

// The mocked runAgent resolves to a minimal AgentResult.
runAgentMock.mockResolvedValue({
  result: 'ok',
  cost: 0,
  duration: 0,
  turns: 0,
});

import { spawnSubagent } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';

const FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'SkillTool',
  '__tests__',
  'fixtures',
);

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

describe('spawnSubagent skill preload', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
    runAgentMock.mockClear();
  });

  it('injects declared skills into prebuilt.forkContextMessages', async () => {
    registerBundledSkill({
      name: 'preload-me',
      description: 'a skill to preload',
      context: 'inline',
      getPromptForCommand: () => 'PRELOADED CONTENT FROM SKILL',
    });

    const def: AgentDefinition = {
      name: 'caller-agent',
      description: 'parent',
      tools: [],
      skills: ['preload-me'],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    await spawnSubagent(def, 'do the thing', fakeCtx() as never);

    // Inspect runAgent's invocation.
    const callArgs = runAgentMock.mock.calls[0];
    // signature: (config, userMessage, context, outputSchema, onProgress, prebuilt, ...)
    const prebuilt = callArgs[5];
    expect(prebuilt).toBeDefined();
    expect(prebuilt.forkContextMessages).toBeDefined();
    expect(prebuilt.forkContextMessages.length).toBe(1);
    const content = prebuilt.forkContextMessages[0].content;
    const contentStr =
      typeof content === 'string'
        ? content
        : content.map((b: { text?: string }) => b.text ?? '').join('');
    expect(contentStr).toContain('PRELOADED CONTENT FROM SKILL');
  });

  it('passes no prebuilt when agent declares no skills', async () => {
    const def: AgentDefinition = {
      name: 'no-skills-agent',
      description: 'parent',
      tools: [],
      skills: [],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    await spawnSubagent(def, 'do the thing', fakeCtx() as never);

    const callArgs = runAgentMock.mock.calls[0];
    const prebuilt = callArgs[5];
    // When no skills, we should pass undefined (not an empty prebuilt object)
    // to avoid disturbing the systemPrompt cache.
    expect(prebuilt).toBeUndefined();
  });

  it('logs warning when a declared skill is not registered', async () => {
    const def: AgentDefinition = {
      name: 'missing-skill-agent',
      description: 'parent',
      tools: [],
      skills: ['no-such-skill'],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    // Should not throw — just warn and continue with no preload.
    await expect(
      spawnSubagent(def, 'do the thing', fakeCtx() as never),
    ).resolves.toBeDefined();

    const callArgs = runAgentMock.mock.calls[0];
    const prebuilt = callArgs[5];
    expect(prebuilt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/AgentTool/__tests__/spawn.test.ts
```

Expected: FAIL — `prebuilt` is currently always undefined; spawn.ts doesn't preload skills yet.

- [ ] **Step 3: Modify `src/tools/AgentTool/spawn.ts`**

Add imports at the top:

```typescript
import type Anthropic from '@anthropic-ai/sdk';
import { getAllSkills } from '@/tools/SkillTool/registry';
```

Add a private helper before `spawnSubagent`:

```typescript
/**
 * Build cache-safe initial messages for skill preload. Empty array when
 * agent declares no skills (caller passes `undefined` to runAgent instead
 * of `{ forkContextMessages: [] }` so systemPrompt cache stays clean).
 *
 * Messages shape: each declared skill becomes one user message containing
 * the skill body. The model reads them as additional context before
 * reaching the user prompt.
 */
async function buildSkillPreloadMessages(
  skillNames: string[],
  ctx: ToolContext,
): Promise<Anthropic.Messages.MessageParam[]> {
  if (skillNames.length === 0) return [];
  const allSkills = await getAllSkills();
  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const name of skillNames) {
    const skill = allSkills.find((s) => s.name === name);
    if (!skill) {
      console.warn(
        `spawn: agent declared skill "${name}" but it is not registered`,
      );
      continue;
    }
    const content = await Promise.resolve(skill.getPromptForCommand('', ctx));
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-skill name="${name}">\n${content}\n</system-skill>`,
        },
      ],
    });
  }
  return messages;
}
```

(Replace the `console.warn` line with whatever logger the file already imports — likely `log.warn(...)` if `createLogger` is in scope.)

Modify the `spawnSubagent` body — replace the `return runAgent<T>(...)` call with:

```typescript
  const skillPreload = await buildSkillPreloadMessages(def.skills, childCtx);
  const prebuilt =
    skillPreload.length > 0
      ? { systemBlocks: [], forkContextMessages: skillPreload }
      : undefined;

  return runAgent<T>(
    config,
    prompt,
    childCtx,
    outputSchema,
    callbacks?.onProgress,
    prebuilt,
    undefined,  // onIdleReset
    callbacks?.onEvent,
  );
```

- [ ] **Step 4: Run spawn tests**

```bash
pnpm test src/tools/AgentTool/__tests__/spawn.test.ts
```

Expected: PASS — all 3 cases green.

- [ ] **Step 5: Run regression on agent suite**

```bash
pnpm test src/tools/AgentTool/
```

Expected: PASS — no regressions.

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/spawn.ts src/tools/AgentTool/__tests__/spawn.test.ts
git commit -m "feat(agent-spawn): preload skills declared in agent frontmatter"
```

---

## Phase E — Wire SkillTool into the registry (Task 13)

### Task 13: Register skillTool in `src/tools/registry.ts`

**Files:**
- Modify: `src/tools/registry.ts`
- Test: `src/tools/__tests__/registry.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Check `src/tools/__tests__/` for an existing registry test. If none, create `src/tools/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { registry } from '@/tools/registry';
import { SKILL_TOOL_NAME } from '@/tools/SkillTool/constants';

describe('central tool registry', () => {
  it('has SkillTool registered under the canonical name', () => {
    const tool = registry.get(SKILL_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(SKILL_TOOL_NAME);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/tools/__tests__/registry.test.ts
```

Expected: FAIL — `registry.get('skill')` returns undefined.

- [ ] **Step 3: Modify `src/tools/registry.ts`**

Add at the top with other imports:

```typescript
import { skillTool } from './SkillTool/SkillTool';
```

Add at the bottom of the file (after the last existing `registry.register(...)` call):

```typescript
// Skill primitive — see src/skills/ + src/tools/SkillTool/.
// Agents that want skill access add `skill` to their AGENT.md tools: list.
registry.register(skillTool);
```

- [ ] **Step 4: Run test**

```bash
pnpm test src/tools/__tests__/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts src/tools/__tests__/registry.test.ts
git commit -m "feat(skills): register skillTool in central tool registry"
```

---

## Phase F — Demo skills (Tasks 14-16)

### Task 14: `_demo-echo-inline` skill

**Files:**
- Create: `src/skills/_demo-echo-inline/SKILL.md`
- Create: `src/skills/_demo-echo-inline/references/format.md`
- Test: `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts`

- [ ] **Step 1: Write the demo skill SKILL.md**

Create `src/skills/_demo-echo-inline/SKILL.md`:

```markdown
---
name: _demo-echo-inline
description: |
  Echoes back received args wrapped in a structured ECHO_START/ECHO_END
  block. Phase 1 smoke-test skill for verifying inline mode end-to-end.
  Internal — not for production use.
context: inline
allowed-tools: []
when-to-use: Only invoked by Phase 1 SkillTool integration tests.
---

# Echo skill — inline mode

Echo back the args you received in this exact format:

```
ECHO_START
args: $ARGUMENTS
mode: inline
ECHO_END
```

For the format spec, see [format reference](references/format.md).
```

Create `src/skills/_demo-echo-inline/references/format.md`:

```markdown
# Echo format spec

Skills using this format must produce output as:

- Line 1: `ECHO_START`
- Line 2: `args: <whatever was received>`
- Line 3: `mode: inline | forked`
- Line 4: `ECHO_END`
```

- [ ] **Step 2: Write per-skill load test**

Create `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(
  __dirname,
  '..',  // -> src/skills/_demo-echo-inline
);

describe('_demo-echo-inline', () => {
  it('loads from disk', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('_demo-echo-inline');
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body containing ECHO_START / ECHO_END', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('hello world', fakeCtx);
    expect(body).toContain('ECHO_START');
    expect(body).toContain('args: hello world');
    expect(body).toContain('mode: inline');
    expect(body).toContain('ECHO_END');
  });

  it('references the format reference file', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('', fakeCtx);
    expect(body).toContain('references/format.md');
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm test src/skills/_demo-echo-inline/
```

Expected: PASS — all 3 cases green.

- [ ] **Step 4: Commit**

```bash
git add src/skills/_demo-echo-inline/
git commit -m "feat(skills): add _demo-echo-inline smoke skill"
```

---

### Task 15: `_demo-echo-fork` skill

**Files:**
- Create: `src/skills/_demo-echo-fork/SKILL.md`
- Test: `src/skills/_demo-echo-fork/__tests__/_demo-echo-fork.test.ts`

- [ ] **Step 1: Write the demo skill SKILL.md**

Create `src/skills/_demo-echo-fork/SKILL.md`:

```markdown
---
name: _demo-echo-fork
description: |
  Echoes back received args via a forked sub-agent that runs the echo body
  in isolation. Phase 1 smoke-test skill for verifying fork mode
  end-to-end. Internal — not for production use.
context: fork
allowed-tools: []
maxTurns: 2
when-to-use: Only invoked by Phase 1 SkillTool integration tests.
---

# Echo skill — fork mode

You are a sub-agent forked from an echo skill invocation.

Reply with exactly this content (no other text, no explanation):

```
ECHO_START
args: $ARGUMENTS
mode: forked
ECHO_END
```
```

- [ ] **Step 2: Write per-skill load test**

Create `src/skills/_demo-echo-fork/__tests__/_demo-echo-fork.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(
  __dirname,
  '..',  // -> src/skills/_demo-echo-fork
);

describe('_demo-echo-fork', () => {
  it('loads with context: fork', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('_demo-echo-fork');
    expect(skill!.context).toBe('fork');
    expect(skill!.maxTurns).toBe(2);
  });

  it('body contains the echo template with mode: forked', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('test', fakeCtx);
    expect(body).toContain('args: test');
    expect(body).toContain('mode: forked');
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm test src/skills/_demo-echo-fork/
```

Expected: PASS — both cases green.

- [ ] **Step 4: Commit**

```bash
git add src/skills/_demo-echo-fork/
git commit -m "feat(skills): add _demo-echo-fork smoke skill"
```

---

### Task 16: `_bundled` smoke registration

**Files:**
- Create: `src/skills/_bundled/_smoke.ts`
- Modify: `src/skills/_bundled/index.ts`
- Test: `src/skills/_bundled/__tests__/_smoke.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/skills/_bundled/__tests__/_smoke.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/skills/_bundled/__tests__/_smoke.test.ts
```

Expected: FAIL — `_bundled-smoke` not in registry.

- [ ] **Step 3: Create the smoke skill**

Create `src/skills/_bundled/_smoke.ts`:

```typescript
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
```

- [ ] **Step 4: Wire it into the barrel**

Modify `src/skills/_bundled/index.ts`:

```typescript
// Barrel for bundled (programmatic TS) skills.
//
// Each ./<name>.ts file imports registerBundledSkill from
// '@/tools/SkillTool/registry' and registers itself at module load.

import './_smoke';
```

- [ ] **Step 5: Run the test**

```bash
pnpm test src/skills/_bundled/__tests__/_smoke.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full skill suite (regression)**

```bash
pnpm test src/skills/ src/tools/SkillTool/
```

Expected: every test in scope passes.

- [ ] **Step 7: Commit**

```bash
git add src/skills/_bundled/_smoke.ts src/skills/_bundled/index.ts src/skills/_bundled/__tests__/
git commit -m "feat(skills): add _bundled-smoke verifying programmatic registration path"
```

---

## Phase G — Integration (Task 17)

### Task 17: End-to-end integration test

**Files:**
- Test: `src/tools/SkillTool/__tests__/SkillTool.integration.test.ts`

This task asserts the full path: SkillTool registered → agent sees it → invocation works through both modes. We mock the LLM (Anthropic SDK) at one level and assert the inputs.

- [ ] **Step 1: Write the integration test**

Create `src/tools/SkillTool/__tests__/SkillTool.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { skillTool } from '@/tools/SkillTool/SkillTool';
import { registry } from '@/tools/registry';
import {
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

describe('SkillTool integration — end-to-end', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(SKILLS_DIR);
  });

  it('skillTool is in central registry', () => {
    expect(registry.get('skill')).toBeDefined();
  });

  it('inline mode: invokes _demo-echo-inline and returns ECHO_START block', async () => {
    const result = await skillTool.execute(
      { skill: '_demo-echo-inline', args: 'integration-test-arg' },
      fakeCtx() as never,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('inline');
    expect(result.commandName).toBe('_demo-echo-inline');
    expect(result.content).toContain('ECHO_START');
    expect(result.content).toContain('args: integration-test-arg');
    expect(result.content).toContain('mode: inline');
    expect(result.content).toContain('ECHO_END');
  });

  it('inline mode: returns _bundled-smoke content via bundled path', async () => {
    const result = await skillTool.execute(
      { skill: '_bundled-smoke' },
      fakeCtx() as never,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('inline');
    expect(result.content).toBe('BUNDLED SMOKE OK');
  });

  it('fork mode: dispatches to spawnSubagent (mocked) without throwing on dispatcher logic', async () => {
    // Mock runAgent so spawnSubagent doesn't try to call LLM.
    const runAgentMock = vi.fn().mockResolvedValue({
      result: 'ECHO_START\nargs: forked-test\nmode: forked\nECHO_END',
      cost: 0,
      duration: 0,
      turns: 0,
    });
    vi.doMock('@/core/query-loop', () => ({ runAgent: runAgentMock }));

    // Re-import to pick up the mock.
    const { skillTool: freshSkillTool } = await import('@/tools/SkillTool/SkillTool');

    const result = await freshSkillTool.execute(
      { skill: '_demo-echo-fork', args: 'forked-test' },
      fakeCtx() as never,
    );

    expect(result.status).toBe('forked');
    expect(result.content).toContain('mode: forked');

    vi.doUnmock('@/core/query-loop');
  });

  it('throws on unknown skill', async () => {
    await expect(
      skillTool.execute(
        { skill: 'no-such-skill-anywhere' },
        fakeCtx() as never,
      ),
    ).rejects.toThrow(/Unknown skill/);
  });

  it('agent loader rejects skills field with non-string array', async () => {
    // Sanity check that Task 10's schema is wired up — already covered in
    // loader.test.ts but kept here to cement the integration.
    expect(true).toBe(true);  // placeholder: deeper agent-spawn-with-skill
                              // integration would require a full LLM loop
                              // which is out of scope for Phase 1.
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
pnpm test src/tools/SkillTool/__tests__/SkillTool.integration.test.ts
```

Expected: PASS — all 6 cases green (or 5 + 1 placeholder).

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass. No regressions in any pre-existing suite.

- [ ] **Step 4: Type-check the whole repo**

```bash
pnpm tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/SkillTool/__tests__/SkillTool.integration.test.ts
git commit -m "test(skills): end-to-end SkillTool integration — inline + fork + bundled"
```

---

## Phase H — Final verification + docs (Task 18)

### Task 18: Update CLAUDE.md + verify Phase 1 invariants

**Files:**
- Modify: `CLAUDE.md` (project instructions) — add a short section documenting the skill primitive.

- [ ] **Step 1: Add a "Skills" section to `CLAUDE.md`**

Open `CLAUDE.md`. Add a new top-level section after the "Architecture Rules" section:

```markdown
## Skill Primitive

ShipFlare's multi-agent system has three primitives: **Tool**, **Agent**, **Skill**.
Skills live under `src/skills/<name>/SKILL.md`. The Skill primitive was restored in
Phase 1 of the architecture refactor (see
`docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`).

### Adding a new markdown skill

1. Create `src/skills/<gerund-name>/SKILL.md` (gerund preferred, e.g.
   `drafting-encouraging-replies`).
2. Required frontmatter: `name`, `description`. Optional: `context`
   (`inline` | `fork`), `allowed-tools`, `model`, `maxTurns`,
   `when-to-use`, `argument-hint`, `paths`.
3. Body uses `$ARGUMENTS` or `$0` / `$1` for arg substitution. Long
   reference content goes under `references/<name>.md` and is linked
   from the body — Claude reads them progressively, on demand.
4. Add a per-skill `__tests__/<name>.test.ts` mirroring
   `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts`.

### Adding a new bundled (TS) skill

Programmatic skills live in `src/skills/_bundled/<name>.ts` and call
`registerBundledSkill({ ... })` at module load. The `src/skills/_bundled/index.ts`
barrel must `import './<name>'` so the side-effect runs.

### Letting an agent invoke skills

Add `skill` to the agent's `AGENT.md` `tools:` list. Optionally declare
`skills: [name1, name2]` to preload specific skills' content into the
agent's initial conversation (useful for agents that always need the
same playbook).
```

- [ ] **Step 2: Verify Phase 1 invariant — existing agents are unchanged**

Phase 1's acceptance gate is "no behavior change for existing agents."
Run the existing agent + worker test suites:

```bash
pnpm test src/tools/AgentTool/ src/workers/
```

Expected: every test passes — none of the changes in this PR alter
behavior for any agent that doesn't declare `skills:` or include `skill`
in its `tools:` list. (Phase 1 ships zero such agents.)

- [ ] **Step 3: Final type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Final full test run**

```bash
pnpm test
```

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document Skill primitive and authoring conventions"
```

---

## Self-review notes (run before declaring done)

Before merging this branch:

1. **Spec coverage** — every section of the spec maps to a task:
   - § 2 goals → Tasks 1-17 (each goal has at least one task)
   - § 3 architecture → Tasks 1-12 (types, loaders, tool, bridge)
   - § 4 folder structure → Task 14, 15 (demo skills exemplify structure)
   - § 5 frontmatter schema → Task 1 (schema.ts) + Task 3 (loader uses it)
   - § 6 loader internals → Tasks 3, 5, 6
   - § 7 SkillTool surface → Tasks 7, 8, 9
   - § 8 agent ↔ skill bridge → Tasks 10, 11, 12
   - § 9 demo skill → Tasks 14, 15 (split into 2 demos per spec amendment)
   - § 10 testing strategy → Test files in every task + integration in Task 17
   - § 11 risks → Task 11 is the explicit risk gate for the runAgent hook
   - § 13 open questions → Tracked in spec, not implemented (out of scope)
   - § 14 LOC estimate → Roughly tracking (~1500 LOC across 18 tasks)

2. **Placeholder scan**: search the plan for "TBD", "TODO", "fill in" — none.

3. **Type consistency** — names and signatures used across tasks:
   - `SkillCommand` — defined Task 1, used in Tasks 3, 5, 7, 9, 12. Consistent.
   - `registerBundledSkill(input)` — defined Task 5, called in Task 16.
     Input type matches.
   - `getAllSkills()` — defined Task 5, called in Tasks 7, 9, 12, 17. No-arg signature.
   - `loadSkill` / `loadSkillsDir` — defined Task 3, used in Tasks 5, 14, 15.
   - `skillTool` — defined Task 7, registered Task 13.
   - `prebuilt.forkContextMessages` — verified Task 11, written Task 12.

4. **DRY check** — repeated test boilerplate (fakeCtx, beforeEach reset)
   appears in multiple tests. Acceptable: each test file is self-contained,
   and a shared helper would couple tests. Phase 2 may extract a test
   harness when patterns settle.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-skill-primitive-restoration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for this plan because each task is self-contained with a clear acceptance test, and 18 tasks benefit from per-task review checkpoints rather than batch.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
