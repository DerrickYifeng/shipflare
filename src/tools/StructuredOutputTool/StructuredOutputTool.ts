// Ported from engine/tools/SyntheticOutputTool/SyntheticOutputTool.ts (Claude Code).
// Structural port: Ajv → Zod, lazySchema → direct schema, buildTool → ToolDefinition,
// TelemetrySafeError → plain Error. WeakMap identity cache kept verbatim.
//
// The tool's input schema is the caller's Zod schema — raw (not sanitized),
// because Anthropic's tool input_schema grammar is strictly larger than
// output_config.format.schema (minItems>1, z.record, nested
// additionalProperties defaults all work here). That is the core reason this
// path exists at all.

import { z, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type Anthropic from '@anthropic-ai/sdk';
import { buildTool } from '@/core/tool-system';
import type { AnyToolDefinition } from '@/core/types';

/**
 * Canonical name exposed to the model. Stable — agents refer to the tool
 * by this constant name in their system prompt. Do NOT rename per-agent.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

/**
 * Environment variable controlling the maximum number of `end_turn` retries
 * when the agent forgets to call StructuredOutput. The enforcement logic
 * lives in `src/core/query-loop.ts` runAgent(); the constant is exported from
 * here so the default is testable without reaching into runAgent.
 */
export const MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT = 5;

export function getMaxStructuredOutputRetries(): number {
  const raw = (process.env.MAX_STRUCTURED_OUTPUT_RETRIES ?? '').trim();
  if (raw === '') return MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT;
  }
  return n;
}

/** The text injected when the agent ends its turn without calling the tool. */
export const STRUCTURED_OUTPUT_CORRECTION =
  'You MUST call StructuredOutput to complete this request. ' +
  'Respond now with a single StructuredOutput tool call whose input is your final structured answer.';

/**
 * Build the Anthropic API tool schema for StructuredOutput using the
 * caller's Zod schema. Emits the raw zod-to-json-schema output — NOT the
 * sanitizer from query-loop.ts — because tool input_schema accepts the
 * constructs output_config.format.schema rejects.
 */
export function buildStructuredOutputApiTool(
  schema: ZodType<unknown>,
): Anthropic.Messages.Tool {
  const input_schema = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema2019-09',
  }) as Anthropic.Messages.Tool['input_schema'];

  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      'Return your final structured answer. Call this tool ONCE at the end of your response. ' +
      "The tool's input IS your final output — do not also emit the answer as text. " +
      'If validation fails, you will receive a tool_result with is_error=true and must call this tool again with corrected input.',
    input_schema,
  };
}

// ---------------------------------------------------------------------------
// ToolDefinition adapter — so StructuredOutput can be slotted into tool lists
// alongside real tools if future callers need it. runAgent() intercepts the
// tool_use block before executeTools() runs (same pattern as the ported CC
// path), so this `execute` method is only called by unit tests that invoke
// the tool directly — it returns the structured input verbatim.
// ---------------------------------------------------------------------------

interface StructuredOutputCacheEntry {
  tool: AnyToolDefinition;
  apiTool: Anthropic.Messages.Tool;
}

const toolCache = new WeakMap<object, StructuredOutputCacheEntry>();

/**
 * Create a StructuredOutput ToolDefinition bound to a caller-provided Zod
 * schema. Cached by schema object identity so repeated calls with the same
 * schema reference reuse the same compiled JSON Schema (Anthropic API tool
 * payload). Matches CC's `WeakMap<object, CreateResult>` pattern.
 *
 * Callers use this primarily for its `.apiTool` output (what gets handed to
 * the Anthropic API). The `.tool` wrapper is provided for parity with
 * ShipFlare's ToolRegistry, but in the hot path runAgent() intercepts the
 * tool_use block and validates without calling `.execute`.
 */
export function createStructuredOutputTool<T>(
  schema: ZodType<T>,
): StructuredOutputCacheEntry {
  const cached = toolCache.get(schema as unknown as object);
  if (cached) return cached;

  const apiTool = buildStructuredOutputApiTool(schema);

  const tool = buildTool({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: apiTool.description ?? '',
    // Accept any object at the ToolDefinition level; the actual shape is
    // enforced by the caller's schema when runAgent validates the input.
    inputSchema: z.record(z.unknown()),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input) {
      // Unit tests may call this directly — validate and round-trip the
      // structured answer. runAgent's intercept path does NOT call here.
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`StructuredOutput validation failed: ${issues}`);
      }
      return {
        data: 'Structured output provided successfully',
        structured_output: parsed.data,
      };
    },
  });

  const entry: StructuredOutputCacheEntry = { tool, apiTool };
  toolCache.set(schema as unknown as object, entry);
  return entry;
}

/**
 * Convenience: validate a raw `tool_use.input` payload against a Zod schema
 * and produce a formatted correction message suitable for round-tripping
 * back as a `tool_result` with `is_error: true`.
 */
export function validateStructuredOutput<T>(
  schema: ZodType<T>,
  input: unknown,
):
  | { ok: true; value: T }
  | { ok: false; message: string } {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const zodMessage = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return {
    ok: false,
    message: `Schema validation failed:\n${zodMessage}\n\nCall ${STRUCTURED_OUTPUT_TOOL_NAME} again with corrected input.`,
  };
}
