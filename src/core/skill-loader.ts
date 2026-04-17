import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillConfig {
  /** Unique skill name (from frontmatter). */
  name: string;
  /** One-line description. */
  description: string;
  /** Execution context: 'fork' runs as sub-agent, 'inline' expands into parent. */
  context: 'inline' | 'fork';
  /** Agent .md file name (without extension) to resolve from agents dir. */
  agent?: string;
  /** Model override for the agent. */
  model?: string;
  /** Tool names the agent is allowed to use. */
  allowedTools?: string[];
  /** Input field to parallelize by (e.g. 'subreddits'). */
  fanOut?: string;
  /** Max concurrent agents in fan-out mode. Default: 5. */
  maxConcurrency?: number;
  /** Per-agent timeout in milliseconds. Default: 60_000. */
  timeout?: number;
  /** Use fanOutCached() for prompt cache sharing. Default: false. */
  cacheSafe?: boolean;
  /** Skills to compose (for orchestrator skills). */
  compose?: string[];
  /** Raw markdown body (the prompt content below frontmatter). */
  prompt: string;
  /** Auto-loaded reference documents from references/ subdirectory. */
  references?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// YAML parser (shared with load-agent.ts pattern)
// ---------------------------------------------------------------------------

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let arrayCollector: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Dash-list continuation
    if (trimmed.startsWith('- ') && currentKey && arrayCollector) {
      arrayCollector.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush any pending array
    if (arrayCollector && currentKey) {
      result[currentKey] = arrayCollector;
      arrayCollector = null;
      currentKey = null;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // Empty value with colon = start of dash-list
    if (!rawValue) {
      currentKey = key;
      arrayCollector = [];
      continue;
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      result[key] = Number(rawValue);
      continue;
    }

    // Boolean
    if (rawValue === 'true') { result[key] = true; continue; }
    if (rawValue === 'false') { result[key] = false; continue; }

    // String (strip quotes if present)
    result[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }

  // Flush trailing array
  if (arrayCollector && currentKey) {
    result[currentKey] = arrayCollector;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * In-process cache of parsed SkillConfigs keyed by skill directory.
 *
 * Parsing a skill walks the FS (SKILL.md + references/*.md + shared refs),
 * splits frontmatter and re-reads each file — expensive to do on every
 * `runSkill` call. Set `DISABLE_SKILL_CACHE=1` for local dev so edits to
 * SKILL.md / references take effect without a restart.
 */
const skillCache = new Map<string, SkillConfig>();

function isCacheDisabled(): boolean {
  return process.env.DISABLE_SKILL_CACHE === '1';
}

/** Clear the skill cache. Primarily for tests. */
export function clearSkillCache(): void {
  skillCache.clear();
}

/**
 * Load a single SKILL.md from a skill directory.
 * Parses YAML frontmatter and returns a SkillConfig.
 */
export function loadSkill(skillDir: string): SkillConfig {
  if (!isCacheDisabled()) {
    const cached = skillCache.get(skillDir);
    if (cached) return cached;
  }

  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found in ${skillDir}`);
  }

  const raw = readFileSync(skillPath, 'utf-8');
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`SKILL.md in ${skillDir} must have YAML frontmatter`);
  }

  const [, yamlBlock, body] = match;
  const meta = parseSimpleYaml(yamlBlock!);

  const name = meta.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`SKILL.md in ${skillDir} missing required 'name' field`);
  }

  // Auto-load reference documents from references/ subdirectory
  const refsDir = join(skillDir, 'references');
  const references: Record<string, string> = {};
  if (existsSync(refsDir)) {
    const refFiles = readdirSync(refsDir).filter(f => f.endsWith('.md'));
    for (const file of refFiles) {
      references[file] = readFileSync(join(refsDir, file), 'utf-8');
    }
  }

  // Load shared references declared in frontmatter
  const sharedRefPaths = Array.isArray(meta['shared-references'])
    ? (meta['shared-references'] as string[])
    : [];
  const sharedRefsRoot = join(process.cwd(), 'src', 'references');
  for (const refPath of sharedRefPaths) {
    const fullPath = join(sharedRefsRoot, refPath);
    const filename = refPath.split('/').pop()!;
    // Skill-local references win on filename collision
    if (existsSync(fullPath) && !(filename in references)) {
      references[filename] = readFileSync(fullPath, 'utf-8');
    }
  }

  const config: SkillConfig = {
    name,
    description: (meta.description as string) ?? '',
    context: (meta.context as 'inline' | 'fork') ?? 'fork',
    agent: meta.agent as string | undefined,
    model: meta.model as string | undefined,
    allowedTools: Array.isArray(meta['allowed-tools']) ? meta['allowed-tools'] : undefined,
    fanOut: (meta['fan-out'] as string) ?? undefined,
    maxConcurrency: typeof meta['max-concurrency'] === 'number' ? meta['max-concurrency'] : undefined,
    timeout: typeof meta.timeout === 'number' ? meta.timeout : undefined,
    cacheSafe: (meta['cache-safe'] as boolean) ?? false,
    compose: Array.isArray(meta.compose) ? meta.compose : undefined,
    prompt: body!.trim(),
    references: Object.keys(references).length > 0 ? references : undefined,
  };

  if (!isCacheDisabled()) {
    skillCache.set(skillDir, config);
  }
  return config;
}

/**
 * Discover and load all skills from a skills root directory.
 * Each subdirectory with a SKILL.md is loaded.
 */
export function loadSkillsDir(skillsRoot: string): Map<string, SkillConfig> {
  const skills = new Map<string, SkillConfig>();
  if (!existsSync(skillsRoot)) return skills;

  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillPath = join(skillDir, 'SKILL.md');
    if (existsSync(skillPath)) {
      const skill = loadSkill(skillDir);
      skills.set(skill.name, skill);
    }
  }

  return skills;
}
