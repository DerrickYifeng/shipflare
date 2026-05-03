import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ToolDefinition,
  ToolContext,
  AnyToolDefinition,
  ValidationResult,
} from './types';

// ---------------------------------------------------------------------------
// buildTool factory (ported from engine/Tool.ts:749-792, merged with bridge)
// ---------------------------------------------------------------------------

/**
 * Tool factory with engine-grade defaults.
 * Combines engine's buildTool() pattern with ShipFlare's flat .ts format.
 *
 * Engine defaults (fail-closed):
 * - isConcurrencySafe: false — must opt-in to parallel execution
 * - isReadOnly: false — must opt-in to mark as side-effect-free
 * - maxResultSizeChars: 100_000 — auto-truncate oversized results
 */
export function buildTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
  validateInput?: (
    input: TInput,
    context: ToolContext,
  ) => Promise<ValidationResult>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultSizeChars?: number;
  aliases?: string[];
}): ToolDefinition<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: config.execute,
    validateInput: config.validateInput,
    isConcurrencySafe: config.isConcurrencySafe ?? false,
    isReadOnly: config.isReadOnly ?? false,
    maxResultSizeChars: config.maxResultSizeChars ?? 100_000,
    aliases: config.aliases,
  };
}

// ---------------------------------------------------------------------------
// Anthropic tool conversion
// ---------------------------------------------------------------------------

/**
 * Anthropic's tool `input_schema` grammar disallows `anyOf` / `oneOf` /
 * `allOf` at the top level (confirmed: official docs + multiple GitHub
 * issues closed as not-planned). The previous fix at d49f1ee only injected
 * `type: 'object'` when it was missing; it left the top-level union in
 * place, which Anthropic still rejects with
 * `tools.N.custom.input_schema: JSON schema is invalid`.
 *
 * `flattenTopLevelUnion` collapses a top-level discriminated union (or any
 * `anyOf` / `oneOf` / `allOf`) into a single permissive object schema for
 * the LLM-facing wire format. Runtime Zod parsing in
 * `SendMessageTool.execute()` is unchanged — it still uses the original
 * discriminated-union schema, so type narrowing on `input.type` works
 * correctly. Only the JSON Schema sent over the API wire is flattened.
 *
 * Flattening rules:
 * - `properties`: union of every variant's properties. The variant
 *   discriminator (e.g. `type` literal-string field) survives as an enum
 *   in the merged property because each variant declares its own literal.
 *   When two variants declare the same property name with different
 *   subtypes the LATER variant wins — fine in practice since the variants
 *   are designed to share field semantics under the discriminator.
 * - `required`: intersection across all variants. Only fields required by
 *   EVERY variant remain required at the top level — typically just the
 *   discriminator. The LLM uses the tool description (and the
 *   discriminator's enum) to know which fields apply per variant; the
 *   server-side Zod schema enforces the per-variant required set at parse
 *   time.
 * - top-level `anyOf` / `oneOf` / `allOf` removed.
 * - other top-level keys (description, $defs, additionalProperties, etc.)
 *   preserved.
 */
function flattenTopLevelUnion(
  serialized: Record<string, unknown>,
): Record<string, unknown> {
  const variants =
    serialized.anyOf ?? serialized.oneOf ?? serialized.allOf;
  if (!Array.isArray(variants) || variants.length === 0) {
    return serialized;
  }

  const mergedProperties: Record<string, unknown> = {};
  const requiredArrays: string[][] = [];

  for (const variant of variants) {
    if (typeof variant !== 'object' || variant === null) continue;
    const v = variant as Record<string, unknown>;
    if (v.properties && typeof v.properties === 'object') {
      Object.assign(
        mergedProperties,
        v.properties as Record<string, unknown>,
      );
    }
    if (Array.isArray(v.required)) {
      requiredArrays.push(v.required as string[]);
    }
  }

  // Required = intersection across all variants. If no variants declared
  // `required`, default to []. Reduce-with-initial-acc would mutate; spread
  // each step to keep the helper itself immutable.
  const requiredIntersection =
    requiredArrays.length === 0
      ? []
      : requiredArrays.reduce<string[]>(
          (acc, arr) => acc.filter((x) => arr.includes(x)),
          [...requiredArrays[0]],
        );

  // Strip union keys + the now-overridden type/properties/required;
  // preserve everything else (description, $defs, additionalProperties…).
  const {
    anyOf: _anyOf,
    oneOf: _oneOf,
    allOf: _allOf,
    type: _type,
    properties: _properties,
    required: _required,
    ...rest
  } = serialized;

  return {
    type: 'object',
    properties: mergedProperties,
    ...(requiredIntersection.length > 0
      ? { required: requiredIntersection }
      : {}),
    ...rest,
  };
}

/**
 * Convert a ToolDefinition to an Anthropic API tool parameter.
 * Uses zod-to-json-schema like engine/Tool.ts does.
 *
 * Target: `jsonSchema7`. The prior `openAi` target emitted
 * `exclusiveMinimum: true` (draft-4 boolean form) for `.positive()` /
 * `.negative()` numbers, which Anthropic's draft-2020-12 validator
 * rejects with `tools.N.custom.input_schema: JSON schema is invalid`.
 * jsonSchema7 emits the number form (`exclusiveMinimum: 0`) that is
 * forward-compatible with 2020-12. Also treats `.optional()` as
 * actually-optional instead of `anyOf: [X, null]` + required.
 *
 * Top-level `anyOf` / `oneOf` / `allOf` is rejected by Anthropic's
 * `input_schema` grammar regardless of whether `type: 'object'` is also
 * present (d49f1ee tried the latter; the API still 400s). For tools whose
 * Zod schema is a discriminated union — notably `SendMessageInputSchema`'s
 * `z.preprocess(z.discriminatedUnion(...))` — we flatten the top-level
 * union into a single permissive object schema via
 * `flattenTopLevelUnion`. See that helper's docstring for the exact merge
 * rules. Runtime Zod validation in the tool's `execute()` keeps using the
 * original discriminated-union schema, so type narrowing inside the tool
 * works correctly.
 */
export function toAnthropicTool(tool: ToolDefinition): Anthropic.Messages.Tool {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });

  // Strip the JSON Schema `$schema` meta field — Anthropic rejects it.
  const schema = { ...(jsonSchema as Record<string, unknown>) };
  delete schema.$schema;

  // Flatten any top-level union into a single object schema. For
  // non-union schemas this is a no-op; for discriminated-union schemas it
  // sets `type: 'object'`, merges properties, and intersects `required`,
  // which supersedes the d49f1ee `type: 'object'`-only injection.
  const flattened = flattenTopLevelUnion(schema);

  // Safety net: if a future zod-to-json-schema construct emits a schema
  // with no top-level union AND no `type`, force `type: 'object'` so the
  // Anthropic grammar is still satisfied.
  if (flattened.type === undefined) {
    flattened.type = 'object';
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: flattened as Anthropic.Messages.Tool['input_schema'],
  };
}

// ---------------------------------------------------------------------------
// Tool Registry (new for ShipFlare, inspired by engine's agentNameRegistry)
// ---------------------------------------------------------------------------

/**
 * Central tool registry for name/alias-based lookup.
 * Replaces ad-hoc Map<string, ToolDefinition> in bridge/load-agent.ts.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly aliases = new Map<string, string>();

  /** Register a tool. Overwrites if name already exists. */
  register(tool: AnyToolDefinition): void {
    this.tools.set(tool.name, tool);
    if (tool.aliases) {
      for (const alias of tool.aliases) {
        this.aliases.set(alias, tool.name);
      }
    }
  }

  /** Lookup by name or alias. Returns undefined if not found. */
  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name) ?? this.tools.get(this.aliases.get(name) ?? '');
  }

  /** Return all registered tools. */
  getAll(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Return just the names of registered tools (Set-friendly for filter pipelines). */
  getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Return a subset of tools matching the given names. */
  getForAgent(names: string[]): AnyToolDefinition[] {
    const result: AnyToolDefinition[] = [];
    for (const name of names) {
      const tool = this.get(name);
      if (tool) {
        result.push(tool);
      }
    }
    return result;
  }

  /** Batch register tools from MCP discovery. */
  loadFromMCP(tools: AnyToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Convert to legacy Map format for bridge compatibility. */
  toMap(): Map<string, AnyToolDefinition> {
    return new Map(this.tools);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
