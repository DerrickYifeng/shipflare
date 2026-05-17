import Anthropic from "@anthropic-ai/sdk";
import { SKILL_REGISTRY } from "./registry";

export interface RunSkillOptions {
  name: string;
  args: Record<string, unknown>;
  env: { ANTHROPIC_API_KEY: string };
  // Declared for Task 3.1c — unused in 3.1b
  writer?: { write: (chunk: unknown) => void };
  parentRunId?: string | null;
  userId?: string;
}

/** @deprecated Use RunSkillOptions instead */
export interface SkillContext {
  env: { ANTHROPIC_API_KEY: string };
}

interface ParsedFrontmatter {
  model: string;
  maxTokens: number;
  system?: string;
}

const DEFAULT_FRONTMATTER: ParsedFrontmatter = {
  model: "claude-sonnet-4-6",
  maxTokens: 2048,
};

/**
 * Pure helper: split a SKILL.md string into its parsed frontmatter and body.
 * Exported for unit tests; not part of the public package surface.
 */
export function parseFrontmatter(md: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: { ...DEFAULT_FRONTMATTER }, body: md };

  const yaml = match[1] ?? "";
  const body = match[2] ?? "";

  const fm: ParsedFrontmatter = { ...DEFAULT_FRONTMATTER };
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rawValue = kv[2] ?? "";
    const value = rawValue.trim();
    if (key === "model") {
      if (value) fm.model = value;
    } else if (key === "maxTokens") {
      const parsed = parseInt(value, 10);
      fm.maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 2048;
    } else if (key === "system") {
      if (value) fm.system = value;
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Pure helper: substitute `{key}` placeholders in a template with values from
 * `args`. Non-string values are JSON.stringified. Exported for unit tests.
 */
export function substituteArguments(
  template: string,
  args: Record<string, unknown>,
): string {
  let out = template;
  for (const [k, v] of Object.entries(args)) {
    const replacement = typeof v === "string" ? v : JSON.stringify(v);
    out = out.replaceAll(`{${k}}`, replacement);
  }
  return out;
}

/**
 * Run a skill end-to-end:
 *   1. Look up the markdown body from SKILL_REGISTRY (throws if missing).
 *   2. Parse YAML frontmatter (model / maxTokens / optional system).
 *   3. Substitute `{key}` placeholders in the body with `args`.
 *   4. Call Anthropic Messages API.
 *   5. Parse the response — try fenced JSON, raw JSON, then return raw text.
 */
export async function runSkill<T = unknown>(opts: RunSkillOptions): Promise<T> {
  const markdown = SKILL_REGISTRY[opts.name];
  if (!markdown) {
    const registered = Object.keys(SKILL_REGISTRY).join(", ");
    throw new Error(
      `Unknown skill: ${opts.name}. Registered skills: ${registered}`,
    );
  }

  const { frontmatter, body } = parseFrontmatter(markdown);
  const prompt = substituteArguments(body, opts.args);

  const client = new Anthropic({ apiKey: opts.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: frontmatter.model,
    max_tokens: frontmatter.maxTokens,
    ...(frontmatter.system ? { system: frontmatter.system } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // 1. Try fenced JSON block first
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1]) as T;
    } catch {
      // fall through
    }
  }

  // 2. Try raw JSON (object or array)
  const rawMatch = text.match(/[{[][\s\S]*[}\]]/);
  if (rawMatch) {
    try {
      return JSON.parse(rawMatch[0]) as T;
    } catch {
      // fall through
    }
  }

  // 3. Fallback: return raw text
  return text as unknown as T;
}

/**
 * Names of all skills registered for runtime use.
 */
export function listSkills(): string[] {
  return Object.keys(SKILL_REGISTRY);
}
