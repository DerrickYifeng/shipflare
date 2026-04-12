import { readFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, ToolDefinition } from './types';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filePath: string,
  toolRegistry: Map<string, ToolDefinition<any, any>>,
): AgentConfig {
  const raw = readFileSync(filePath, 'utf-8');
  return parseAgentMarkdown(raw, toolRegistry);
}

/**
 * Load all agent definitions from a directory.
 */
export function loadAgentsFromDir(
  dirPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolRegistry: Map<string, ToolDefinition<any, any>>,
): AgentConfig[] {
  const { readdirSync } = require('fs') as typeof import('fs');
  const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.md'));
  return files.map((f: string) =>
    loadAgentFromFile(join(dirPath, f), toolRegistry),
  );
}

/**
 * Parse markdown with YAML frontmatter into AgentConfig.
 */
export function parseAgentMarkdown(
  raw: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolRegistry: Map<string, ToolDefinition<any, any>>,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: ToolDefinition<any, any>[] = toolNames.map((tn) => {
    const tool = toolRegistry.get(tn);
    if (!tool) {
      throw new Error(`Agent "${name}": unknown tool "${tn}"`);
    }
    return tool;
  });

  return {
    name,
    systemPrompt: body!.trim(),
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
