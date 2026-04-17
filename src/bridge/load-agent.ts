import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type { AgentConfig, AnyToolDefinition } from './types';
import type { ToolRegistry } from '@/core/tool-system';

/** Accept either a ToolRegistry or a legacy Map for tool resolution. */
type ToolSource = ToolRegistry | Map<string, AnyToolDefinition>;

function lookupTool(source: ToolSource, name: string): AnyToolDefinition | undefined {
  if ('getForAgent' in source) {
    return source.get(name);
  }
  return source.get(name);
}

/** Lazily loaded ReAct preamble, cached after first read. */
let reactPreambleCache: string | null = null;

/**
 * Parsed AgentConfig cache keyed by agent file path. Each `runSkill` call
 * previously re-parsed the markdown + YAML and re-resolved tools; this cache
 * collapses that to a single parse per process lifetime.
 *
 * Disable with `DISABLE_SKILL_CACHE=1` for local development so edits to
 * agent .md files take effect without a restart.
 */
const agentConfigCache = new Map<string, AgentConfig>();

function isCacheDisabled(): boolean {
  return process.env.DISABLE_SKILL_CACHE === '1';
}

/**
 * Clear the agent config cache. Primarily for tests.
 */
export function clearAgentConfigCache(): void {
  agentConfigCache.clear();
}

function getReactPreamble(agentsDir: string): string {
  if (reactPreambleCache !== null) return reactPreambleCache;
  const preamblePath = join(agentsDir, 'react-preamble.md');
  if (existsSync(preamblePath)) {
    reactPreambleCache = readFileSync(preamblePath, 'utf-8').trim();
  } else {
    reactPreambleCache = '';
  }
  return reactPreambleCache;
}

/**
 * Parse a markdown agent definition with YAML frontmatter.
 * Following engine's loadAgentsDir.ts pattern.
 *
 * Format:
 * ---
 * name: discovery
 * model: claude-haiku-4-5-20251001
 * tools: [reddit_search]
 * maxTurns: 10
 * ---
 * System prompt content here...
 */
export function loadAgentFromFile(
  filePath: string,
  toolSource: ToolSource,
): AgentConfig {
  if (!isCacheDisabled()) {
    const cached = agentConfigCache.get(filePath);
    if (cached) return cached;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const agentsDir = dirname(filePath);
  const parsed = parseAgentMarkdown(raw, toolSource, agentsDir);

  if (!isCacheDisabled()) {
    agentConfigCache.set(filePath, parsed);
  }
  return parsed;
}

/**
 * Load all agent definitions from a directory.
 */
export function loadAgentsFromDir(
  dirPath: string,
  toolSource: ToolSource,
): AgentConfig[] {
  const files = readdirSync(dirPath).filter(
    (f) => f.endsWith('.md') && f !== 'react-preamble.md',
  );
  return files.map((f) => loadAgentFromFile(join(dirPath, f), toolSource));
}

/**
 * Parse markdown with YAML frontmatter into AgentConfig.
 * Automatically injects the ReAct preamble into all agent system prompts.
 */
export function parseAgentMarkdown(
  raw: string,
  toolSource: ToolSource,
  agentsDir?: string,
): AgentConfig {
  const frontmatterMatch = raw.match(
    /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
  );

  if (!frontmatterMatch) {
    throw new Error('Agent markdown must have YAML frontmatter');
  }

  const [, yamlBlock, body] = frontmatterMatch;
  const meta = parseSimpleYaml(yamlBlock!);

  const name = requireString(meta, 'name');
  const model = requireString(meta, 'model');
  const maxTurns = typeof meta.maxTurns === 'number' ? meta.maxTurns : 10;

  // Resolve tool names to ToolDefinition instances
  const toolNames: string[] = Array.isArray(meta.tools) ? meta.tools : [];
  const tools: AnyToolDefinition[] = toolNames.map((tn) => {
    const tool = lookupTool(toolSource, tn);
    if (!tool) {
      throw new Error(`Agent "${name}": unknown tool "${tn}"`);
    }
    return tool;
  });

  // Auto-inject ReAct preamble
  let systemPrompt = body!.trim();
  if (agentsDir) {
    const preamble = getReactPreamble(agentsDir);
    if (preamble) {
      systemPrompt = `${preamble}\n\n${systemPrompt}`;
    }
  }

  return {
    name,
    systemPrompt,
    model,
    tools,
    maxTurns,
  };
}

/**
 * Minimal YAML parser for agent frontmatter.
 * Handles: string values, numbers, arrays (inline [...] and dash-list).
 */
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

function requireString(
  meta: Record<string, unknown>,
  key: string,
): string {
  const value = meta[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Agent frontmatter missing required string: "${key}"`);
  }
  return value;
}
