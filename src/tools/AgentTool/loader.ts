// Ported from engine/tools/AgentTool/loadAgentsDir.ts parseAgent() (Claude Code);
// validators for hooks/mcpServers/permissionMode/isolation/initialPrompt/memory/
// omitClaudeMd/requiredMcpServers/background are intentionally dropped — ShipFlare
// agents live in-process under our own BullMQ worker, not CC's CLI runtime.
// `skills` is parsed as a first-class field (see AgentDefinition.skills).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('tools:agent-loader');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];   // restored Phase A — see Agent Teams spec §5
  skills: string[];
  model?: string;
  maxTurns: number;
  color?: string;
  /** Markdown body + inlined references + inlined shared-references. */
  systemPrompt: string;
  /** Absolute path to the AGENT.md file that produced this definition. */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Frontmatter shape
// ---------------------------------------------------------------------------
//
// Only the fields ShipFlare honors are validated here. Unknown keys survive
// parsing but are discarded during construction — we log a single warning per
// file listing the dropped keys so ported AGENT.md files don't silently carry
// CC-runtime config that has no effect.

// Match Claude Code's FORK_AGENT.maxTurns (engine/tools/AgentTool/forkSubagent.ts:65).
// This is a circuit breaker for runaway loops, NOT a natural-termination
// bound — agents should hit StructuredOutput / end_turn long before this.
const DEFAULT_MAX_TURNS = 200;

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

const frontmatterSchema = z
  .object({
    name: z
      .string({ required_error: 'name is required' })
      .min(1, 'name cannot be empty')
      .regex(
        AGENT_NAME_PATTERN,
        'name must match /^[a-z][a-z0-9_-]*$/',
      ),
    description: z
      .string({ required_error: 'description is required' })
      .min(1, 'description cannot be empty'),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    color: z.string().min(1).optional(),
    references: z.array(z.string()).optional(),
    'shared-references': z.array(z.string()).optional(),
  })
  .passthrough();

type ParsedFrontmatter = z.infer<typeof frontmatterSchema>;

// CC-only fields we explicitly strip (and warn about) so ports don't rot.
const DROPPED_FIELDS = [
  'hooks',
  'mcpServers',
  'permissionMode',
  'isolation',
  'initialPrompt',
  'memory',
  'omitClaudeMd',
  'requiredMcpServers',
  'background',
  // disallowedTools restored Phase A — see Agent Teams spec §5
  'effort',
] as const;

// ---------------------------------------------------------------------------
// Frontmatter splitter (portable across `---` fences)
// ---------------------------------------------------------------------------

interface SplitResult {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(source: string): SplitResult {
  // Normalize CRLF so the regex stays simple.
  const normalized = source.replace(/\r\n/g, '\n');
  // Must start with `---` on its own line.
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error(
      'AGENT.md is missing YAML frontmatter (expected leading `---` fence)',
    );
  }
  return { frontmatter: match[1], body: match[2] };
}

// ---------------------------------------------------------------------------
// Minimal YAML subset parser
// ---------------------------------------------------------------------------
//
// We deliberately avoid pulling in `js-yaml` / `yaml` — neither is currently a
// project dependency, and the frontmatter shape is narrow: scalars, quoted
// strings, inline + block arrays, and single-level `key: value` pairs. A
// hand-rolled reader keeps the loader dependency-free and makes the surface
// area we need to reason about explicit. If a future AGENT.md needs nested
// mappings we'll swap in `yaml` behind this same API.

type YamlValue = string | number | boolean | string[] | null;

function parseYamlFrontmatter(src: string): Record<string, YamlValue> {
  const lines = src.split('\n');
  const out: Record<string, YamlValue> = {};

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = stripTrailingComment(rawLine);

    // Skip blank / comment-only lines.
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (/^\s*#/.test(line)) {
      i += 1;
      continue;
    }

    // Top-level key lines MUST start at column 0 (no leading whitespace).
    // Anything indented at this level that isn't part of a recognized
    // continuation (block list `-`, quoted multi-line, YAML folded block) is
    // a shape we don't support.
    if (/^\s/.test(line)) {
      throw new Error(
        `Unsupported YAML indentation at line ${i + 1}: ${JSON.stringify(rawLine)}`,
      );
    }

    const keyMatch = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      throw new Error(
        `Invalid YAML line ${i + 1}: ${JSON.stringify(rawLine)}`,
      );
    }
    const key = keyMatch[1];
    const rest = keyMatch[2];

    if (rest === '' || rest === undefined) {
      // Block form — collect following indented `- item` lines and/or folded
      // continuation lines. The spec uses block lists for `tools`,
      // `references`, and `shared-references`; and folded `description:`
      // wrapping over several indented lines.
      const { value, nextIndex } = readBlockValue(lines, i + 1);
      out[key] = value;
      i = nextIndex;
      continue;
    }

    // Inline scalar or inline array.
    out[key] = parseInlineScalar(rest);
    i += 1;
  }

  return out;
}

function stripTrailingComment(line: string): string {
  // Comments are only stripped outside quoted strings. The frontmatter shapes
  // we accept never embed `#` inside values, so a simple check is fine: if a
  // line contains an unquoted `#` preceded by whitespace, drop the tail.
  if (!line.includes('#')) return line;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseInlineScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  // Inline array literal: `[a, b, c]`.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0);
  }

  // Booleans / null.
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;

  // Unquoted integer (positive or negative).
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }

  // Quoted or plain string.
  return unquote(trimmed);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    // Only "\n" → actual newline; keep it minimal.
    return value.startsWith('"') ? inner.replace(/\\n/g, '\n') : inner;
  }
  return value;
}

interface BlockResult {
  value: YamlValue;
  nextIndex: number;
}

function readBlockValue(lines: string[], startIndex: number): BlockResult {
  // Peek at the next non-blank line.
  let j = startIndex;
  while (j < lines.length && lines[j].trim() === '') {
    j += 1;
  }

  // Case 1 — block sequence (`  - item`).
  if (j < lines.length && /^\s+-\s*/.test(lines[j])) {
    const items: string[] = [];
    while (j < lines.length) {
      const ln = lines[j];
      if (ln.trim() === '') {
        j += 1;
        continue;
      }
      const m = /^(\s+)-\s*(.*)$/.exec(ln);
      if (!m) break;
      const value = m[2].trim();
      // Strip trailing inline comment inside the item (outside quotes).
      const cleaned = stripTrailingComment(value).trim();
      items.push(unquote(cleaned));
      j += 1;
    }
    return { value: items, nextIndex: j };
  }

  // Case 2 — folded scalar (description wraps across 2+ indented lines).
  // We greedily collect indented lines and join them with single spaces.
  const parts: string[] = [];
  while (j < lines.length) {
    const ln = lines[j];
    if (ln.trim() === '') break;
    if (!/^\s/.test(ln)) break;
    parts.push(ln.trim());
    j += 1;
  }
  if (parts.length === 0) {
    // Empty value — treat as empty string (caller's Zod will reject for
    // required fields).
    return { value: '', nextIndex: j };
  }
  return { value: parts.join(' '), nextIndex: j };
}

// ---------------------------------------------------------------------------
// Reference inlining
// ---------------------------------------------------------------------------

/**
 * Shared-references resolver. The canonical runtime path is
 * `src/tools/AgentTool/agents/_shared/references/`; tests override via
 * `opts.sharedReferencesDir` so fixtures stay self-contained.
 *
 * A file may also live at the tool-description-scoped path
 * `src/tools/AgentTool/references/` (today: `delegation-teaching.md`).
 * That file is auto-injected into the Task tool description by
 * `prompt.ts`, AND also ends up in an agent's system prompt whenever
 * the AGENT.md's `shared-references:` list names it — so an agent
 * (like the coordinator) that wants both the Task-tool-description
 * surface AND an inlined copy in its own system prompt can reference
 * it without duplicating the file.
 */
async function resolveSharedReference(
  entry: string,
  opts: LoadOptions,
): Promise<string> {
  const normalized = entry.endsWith('.md') ? entry : `${entry}.md`;
  const primaryDir =
    opts.sharedReferencesDir ??
    path.resolve(
      process.cwd(),
      'src/tools/AgentTool/agents/_shared/references',
    );
  const primaryPath = path.join(primaryDir, normalized);
  try {
    return await fs.readFile(primaryPath, 'utf8');
  } catch (primaryErr) {
    // Fallback: tool-description-scoped references. Only applied for the
    // production root (tests still see the strict single-dir behavior so
    // fixture isolation is preserved).
    if (opts.sharedReferencesDir === undefined) {
      const fallbackDir = path.resolve(
        process.cwd(),
        'src/tools/AgentTool/references',
      );
      const fallbackPath = path.join(fallbackDir, normalized);
      try {
        return await fs.readFile(fallbackPath, 'utf8');
      } catch {
        // Fall through to the primary error.
      }
    }
    throw primaryErr;
  }
}

export async function resolveReferenceFile(
  agentDir: string,
  entry: string,
): Promise<string> {
  const normalized = entry.endsWith('.md') ? entry : `${entry}.md`;
  const full = path.join(agentDir, 'references', normalized);
  return fs.readFile(full, 'utf8');
}

export function inlineReference(
  body: string,
  entry: string,
  content: string,
): string {
  const normalized = entry.replace(/\.md$/, '');
  return `${body}\n\n## ${normalized}\n\n${content.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Loader API
// ---------------------------------------------------------------------------

interface LoadOptions {
  /** Override shared-references directory (used by tests). */
  sharedReferencesDir?: string;
}

export async function loadAgent(
  agentDirPath: string,
  options: LoadOptions = {},
): Promise<AgentDefinition> {
  const agentMdPath = path.join(agentDirPath, 'AGENT.md');
  const source = await fs.readFile(agentMdPath, 'utf8');

  const { frontmatter, body } = splitFrontmatter(source);
  const raw = parseYamlFrontmatter(frontmatter);

  const parsed: ParsedFrontmatter = frontmatterSchema.parse(raw);

  // Warn (once per file) about any dropped CC-only keys that survived parsing.
  const dropped = DROPPED_FIELDS.filter((key) =>
    Object.prototype.hasOwnProperty.call(raw, key),
  );
  if (dropped.length > 0) {
    log.warn(
      `[${agentMdPath}] ignoring unsupported frontmatter keys (CC-only): ${dropped.join(
        ', ',
      )}`,
    );
  }

  let systemPrompt = body.trim();

  const perAgentRefs = parsed.references ?? [];
  for (const entry of perAgentRefs) {
    let content: string;
    try {
      content = await resolveReferenceFile(agentDirPath, entry);
    } catch (err) {
      throw new Error(
        `Agent "${parsed.name}" references missing file "${entry}" under ${path.join(
          agentDirPath,
          'references',
        )}: ${(err as Error).message}`,
      );
    }
    systemPrompt = inlineReference(systemPrompt, entry, content);
  }

  const sharedRefs = parsed['shared-references'] ?? [];
  for (const entry of sharedRefs) {
    let content: string;
    try {
      content = await resolveSharedReference(entry, options);
    } catch (err) {
      throw new Error(
        `Agent "${parsed.name}" references missing shared file "${entry}": ${
          (err as Error).message
        }`,
      );
    }
    systemPrompt = inlineReference(systemPrompt, entry, content);
  }

  return {
    name: parsed.name,
    description: parsed.description,
    tools: parsed.tools ?? [],
    disallowedTools: parsed.disallowedTools ?? [],
    skills: parsed.skills ?? [],
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    maxTurns: parsed.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(parsed.color !== undefined ? { color: parsed.color } : {}),
    systemPrompt,
    sourcePath: agentMdPath,
  };
}

export async function loadAgentsDir(
  rootDir: string,
  options: LoadOptions = {},
): Promise<AgentDefinition[]> {
  const agentDirs = await discoverAgentDirs(rootDir);
  const loaded = await Promise.all(
    agentDirs.map((dir) => loadAgent(dir, options)),
  );

  // Sort by name for deterministic output.
  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}

interface MinimalDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

async function discoverAgentDirs(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries: MinimalDirent[];
    try {
      entries = (await fs.readdir(current, {
        withFileTypes: true,
      })) as unknown as MinimalDirent[];
    } catch {
      continue;
    }

    let hasAgentMd = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'AGENT.md') {
        hasAgentMd = true;
      }
    }

    if (hasAgentMd) {
      results.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip the shared-references bucket — it holds only reference docs.
      if (entry.name === '_shared') continue;
      if (entry.name.startsWith('.')) continue;
      stack.push(path.join(current, entry.name));
    }
  }

  return results.sort();
}
