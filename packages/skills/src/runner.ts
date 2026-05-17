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

  // Emit data-skill-start before the Anthropic call
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

  const t0 = Date.now();
  let result: T;
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

    // 1. Try fenced JSON block first
    const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (fencedMatch && fencedMatch[1]) {
      try {
        result = JSON.parse(fencedMatch[1]) as T;
        // Emit success data part and telemetry
        if (opts.writer) {
          opts.writer.write({
            id: runId,
            type: "data-skill-finish",
            data: { skillName, status: "ok" },
          });
        }
        writeAgentEvent(opts.env, {
          kind: "skill_invocation",
          userId,
          runId,
          blobs: [skillName, "ok", frontmatter.model, frontmatter.context],
          doubles: [Date.now() - t0],
        });
        return result;
      } catch {
        // fall through
      }
    }

    // 2. Try raw JSON (object or array)
    const rawMatch = text.match(/[{[][\s\S]*[}\]]/);
    if (rawMatch) {
      try {
        result = JSON.parse(rawMatch[0]) as T;
        // Emit success data part and telemetry
        if (opts.writer) {
          opts.writer.write({
            id: runId,
            type: "data-skill-finish",
            data: { skillName, status: "ok" },
          });
        }
        writeAgentEvent(opts.env, {
          kind: "skill_invocation",
          userId,
          runId,
          blobs: [skillName, "ok", frontmatter.model, frontmatter.context],
          doubles: [Date.now() - t0],
        });
        return result;
      } catch {
        // fall through
      }
    }

    // 3. Fallback: return raw text
    result = text as unknown as T;
    if (opts.writer) {
      opts.writer.write({
        id: runId,
        type: "data-skill-finish",
        data: { skillName, status: "ok" },
      });
    }
    writeAgentEvent(opts.env, {
      kind: "skill_invocation",
      userId,
      runId,
      blobs: [skillName, "ok", frontmatter.model, frontmatter.context],
      doubles: [Date.now() - t0],
    });
    return result;
  } catch (err) {
    // Emit error data part and telemetry, then re-raise
    if (opts.writer) {
      opts.writer.write({
        id: runId,
        type: "data-skill-finish",
        data: { skillName, status: "error", error: String(err) },
      });
    }
    writeAgentEvent(opts.env, {
      kind: "skill_invocation",
      userId,
      runId,
      blobs: [skillName, "error", frontmatter.model, frontmatter.context],
      doubles: [Date.now() - t0],
    });
    throw err;
  }
}

/**
 * Names of all skills registered for runtime use.
 */
export function listSkills(): string[] {
  return Object.keys(SKILL_REGISTRY);
}
