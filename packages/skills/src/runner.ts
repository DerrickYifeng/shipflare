import Anthropic from "@anthropic-ai/sdk";
import { writeAgentEvent } from "@shipflare/shared";
import { SKILL_REGISTRY } from "./registry";

export interface RunSkillOptions {
  name: string;
  args: Record<string, unknown>;
  env: { ANTHROPIC_API_KEY: string; TELEMETRY?: AnalyticsEngineDataset };
  writer?: { write: (chunk: unknown) => void };
  parentRunId?: string | null;
  userId?: string;
}

interface ParsedFrontmatter {
  model: string;
  maxTokens: number;
  system?: string;
  context: string;
}

const DEFAULT_FRONTMATTER: ParsedFrontmatter = {
  model: "claude-sonnet-4-6",
  maxTokens: 2048,
  context: "inline",
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
    } else if (key === "context") {
      if (value) fm.context = value;
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
 *   2. Parse YAML frontmatter (model / maxTokens / optional system / context).
 *   3. Substitute `{key}` placeholders in the body with `args`.
 *   4. Emit `data-skill-start` part (if `opts.writer` is present).
 *   5. Call Anthropic Messages API (timed).
 *   6. Parse the response — try fenced JSON, raw JSON, then return raw text.
 *   7. Emit `data-skill-finish` part and write telemetry on success or error.
 *      On error, re-raises the original exception after emitting.
 */
/**
 * Pure helper: parse a model-response text into T. Tries fenced ```json``` first,
 * then raw JSON-shaped substring, then returns the original text cast to T.
 */
function parseResponseText<T>(text: string): T {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1]) as T;
    } catch {
      // fall through
    }
  }
  const rawMatch = text.match(/[{[][\s\S]*[}\]]/);
  if (rawMatch) {
    try {
      return JSON.parse(rawMatch[0]) as T;
    } catch {
      // fall through
    }
  }
  return text as unknown as T;
}

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
  const skillName = opts.name;
  const runId = crypto.randomUUID();
  const userId = opts.userId ?? "unknown";
  const t0 = Date.now();

  // Single source of truth for finish-side emission + telemetry. Called from
  // both the success path and the error path so they can never drift.
  const emitFinish = (status: "ok" | "error", error?: string): void => {
    if (opts.writer) {
      opts.writer.write({
        id: runId,
        type: "data-skill-finish",
        data:
          status === "error"
            ? { skillName, status, error }
            : { skillName, status },
      });
    }
    writeAgentEvent(opts.env, {
      kind: "skill_invocation",
      userId,
      runId,
      blobs: [skillName, status, frontmatter.model, frontmatter.context],
      doubles: [Date.now() - t0],
    });
  };

  if (opts.writer) {
    opts.writer.write({
      id: runId,
      type: "data-skill-start",
      data: {
        skillName,
        model: frontmatter.model,
        context: frontmatter.context,
        parentRunId: opts.parentRunId ?? null,
      },
    });
  }

  try {
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

    const result = parseResponseText<T>(text);
    emitFinish("ok");
    return result;
  } catch (err) {
    emitFinish("error", String(err));
    throw err;
  }
}

/**
 * Names of all skills registered for runtime use.
 */
export function listSkills(): string[] {
  return Object.keys(SKILL_REGISTRY);
}
