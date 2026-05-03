// Regression: Anthropic's tool input_schema grammar requires top-level
// `type: 'object'` AND disallows `anyOf` / `oneOf` / `allOf` at the top
// level (see node_modules/@anthropic-ai/sdk/.../messages.d.ts —
// `Tool.InputSchema.type: 'object'` is non-optional; the
// no-top-level-union rule is documented + confirmed via several "closed
// as not-planned" GitHub issues against the SDK).
//
// History of this regression:
//   1. Some Zod constructs — notably `z.preprocess(...)` wrapping a
//      discriminated union, which is how `SendMessageInputSchema` is
//      built — emit a top-level `{ anyOf: [...] }` with no `type` field.
//      Anthropic rejected the request with
//      `tools.N.custom.input_schema.type: Field required`.
//   2. d49f1ee patched that by injecting `type: 'object'` when missing —
//      but left the `anyOf` in place, which Anthropic STILL rejects with
//      `tools.N.custom.input_schema: JSON schema is invalid`.
//   3. The real fix flattens the top-level union into a single permissive
//      object schema for the wire format; runtime Zod parsing in the
//      tool's `execute()` keeps using the original discriminated union.
//
// This test:
//   - asserts every coordinator tool's serialized shape has
//     `type: 'object'`, AND
//   - asserts the SendMessage shape has NO top-level `anyOf` / `oneOf` /
//     `allOf`, AND
//   - exercises the `z.preprocess(discriminatedUnion(...))` shape in
//     isolation so future regressions point at the conversion helper.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildTool, toAnthropicTool } from '@/core/tool-system';
import { registry } from '@/tools/registry';
import { sendMessageTool } from '@/tools/SendMessageTool/SendMessageTool';
import { taskTool } from '@/tools/AgentTool/AgentTool';
import { syntheticOutputTool } from '@/tools/SyntheticOutputTool/SyntheticOutputTool';
import { sleepTool } from '@/tools/SleepTool/SleepTool';
import { taskStopTool } from '@/tools/TaskStopTool/TaskStopTool';
import type { ToolDefinition } from '@/core/types';

// `ToolDefinition<TInput, TOutput>` is invariant in TInput / TOutput, so a
// concrete `ToolDefinition<{...}, ...>` is not assignable to
// `ToolDefinition<unknown, unknown>` (which `toAnthropicTool` accepts). The
// helper only reads `name`, `description`, and `inputSchema`, so the cast
// is structurally sound — we just suppress the variance check at the
// boundary so tests can pass concrete tools without rebuilding their
// schema generics.
const asAnyTool = <I, O>(
  t: ToolDefinition<I, O>,
): ToolDefinition<unknown, unknown> =>
  t as unknown as ToolDefinition<unknown, unknown>;

// Coordinator's concrete (non-virtual) tool list, mirroring its AGENT.md
// frontmatter. `StructuredOutput` is intentionally excluded — it is
// synthesized at runtime by runAgent from the caller's outputSchema and
// goes through `buildStructuredOutputApiTool`, which has its own
// regression coverage in `query-loop-structured-output.test.ts`.
const COORDINATOR_REGISTRY_TOOLS = [
  'query_team_status',
  'query_plan_items',
  'query_strategic_path',
  'generate_strategic_path',
  'add_plan_item',
  'update_plan_item',
];

describe('toAnthropicTool — Anthropic input_schema invariants', () => {
  it("flattens SendMessage's discriminated union to a single object schema (no top-level anyOf/oneOf/allOf)", () => {
    const apiTool = toAnthropicTool(asAnyTool(sendMessageTool));
    const schema = apiTool.input_schema as Record<string, unknown>;

    // Anthropic requires top-level type: 'object' AND rejects top-level
    // unions. Both must hold simultaneously.
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('allOf');

    // The flattened `properties` should be the union of every variant's
    // properties so the LLM can see every legal field. The SendMessage
    // discriminated union has variants for: message, broadcast,
    // shutdown_request, shutdown_response, plan_approval_response — the
    // union of their fields covers the discriminator + every variant
    // field name.
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    if (!props) return;
    // Discriminator is in every variant.
    expect(props).toHaveProperty('type');
    // Variant fields surface as optional properties.
    expect(props).toHaveProperty('to');
    expect(props).toHaveProperty('content');
    expect(props).toHaveProperty('request_id');
    expect(props).toHaveProperty('approve');
    expect(props).toHaveProperty('summary');
    expect(props).toHaveProperty('run_id');

    // `required` = intersection of every variant's required set. Only
    // `type` is required in EVERY variant of SendMessage's union; every
    // other field is required only by some variants. Intersection
    // collapses to ['type'].
    expect(schema.required).toEqual(['type']);
  });

  it("emits top-level type: 'object' for Task", () => {
    expect(toAnthropicTool(asAnyTool(taskTool)).input_schema.type).toBe(
      'object',
    );
  });

  it("emits top-level type: 'object' for SyntheticOutput", () => {
    expect(
      toAnthropicTool(asAnyTool(syntheticOutputTool)).input_schema.type,
    ).toBe('object');
  });

  it("emits top-level type: 'object' for Sleep", () => {
    expect(toAnthropicTool(asAnyTool(sleepTool)).input_schema.type).toBe(
      'object',
    );
  });

  it("emits top-level type: 'object' for TaskStop", () => {
    expect(toAnthropicTool(asAnyTool(taskStopTool)).input_schema.type).toBe(
      'object',
    );
  });

  it.each(COORDINATOR_REGISTRY_TOOLS)(
    "emits top-level type: 'object' for %s",
    (toolName) => {
      const tool = registry.get(toolName);
      expect(tool, `tool ${toolName} must be registered`).toBeDefined();
      const apiTool = toAnthropicTool(asAnyTool(tool!));
      expect(apiTool.input_schema.type).toBe('object');
    },
  );

  it("flattens preprocess+union schemas (no top-level union, intersected required, merged properties)", () => {
    // Construct the same shape SendMessage uses, in isolation, so the
    // failure mode is unambiguous if the helper regresses.
    const variantA = z.object({
      type: z.literal('a'),
      payload: z.string(),
      onlyA: z.string(),
    });
    const variantB = z.object({
      type: z.literal('b'),
      payload: z.number(),
      onlyB: z.boolean(),
    });
    const schema = z.preprocess(
      (raw) => raw,
      z.discriminatedUnion('type', [variantA, variantB]),
    );

    const tool = buildTool({
      name: 'preprocess_union_probe',
      description: 'test fixture for the preprocess-union edge case',
      inputSchema: schema as unknown as z.ZodType<z.infer<typeof schema>>,
      async execute() {
        return null;
      },
    });

    const apiTool = toAnthropicTool(asAnyTool(tool));
    const out = apiTool.input_schema as Record<string, unknown>;

    // Top-level shape: object, no union remnants.
    expect(out.type).toBe('object');
    expect(out).not.toHaveProperty('anyOf');
    expect(out).not.toHaveProperty('oneOf');
    expect(out).not.toHaveProperty('allOf');

    // Properties: union of every variant's properties.
    const props = out.properties as Record<string, unknown>;
    expect(props).toHaveProperty('type');
    expect(props).toHaveProperty('payload');
    expect(props).toHaveProperty('onlyA');
    expect(props).toHaveProperty('onlyB');

    // Required: intersection. Both variants require {type, payload};
    // onlyA/onlyB are each required by only one. Intersection = sorted
    // by stable order of the first variant.
    expect(out.required).toEqual(
      expect.arrayContaining(['type', 'payload']),
    );
    expect(out.required).not.toContain('onlyA');
    expect(out.required).not.toContain('onlyB');
  });

  it("preserves an existing top-level type when zod-to-json-schema sets it", () => {
    // Sanity check: the injection must not clobber the natural `type` for
    // ordinary `z.object(...)`-rooted schemas.
    const tool = buildTool({
      name: 'plain_object_probe',
      description: 'test fixture for the happy path',
      inputSchema: z.object({ value: z.string() }),
      async execute() {
        return null;
      },
    });
    expect(toAnthropicTool(asAnyTool(tool)).input_schema.type).toBe('object');
  });
});
