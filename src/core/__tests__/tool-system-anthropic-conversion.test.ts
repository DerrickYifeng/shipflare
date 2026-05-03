// Regression: Anthropic's tool input_schema grammar requires top-level
// `type: 'object'` AND disallows `anyOf` / `oneOf` / `allOf` at the top
// level (see node_modules/@anthropic-ai/sdk/.../messages.d.ts —
// `Tool.InputSchema.type: 'object'` is non-optional; the
// no-top-level-union rule is documented + confirmed via several "closed
// as not-planned" GitHub issues against the SDK).
//
// History of this regression:
//   1. Some Zod constructs — notably `z.preprocess(...)` wrapping a
//      discriminated union, which is how `SendMessageInputSchema` USED to
//      be built — emit a top-level `{ anyOf: [...] }` with no `type` field.
//      Anthropic rejected the request with
//      `tools.N.custom.input_schema.type: Field required`.
//   2. d49f1ee patched that by injecting `type: 'object'` when missing —
//      but left the `anyOf` in place, which Anthropic STILL rejects with
//      `tools.N.custom.input_schema: JSON schema is invalid`.
//   3. The flatten-top-level-union helper collapses any remaining top-level
//      union into a single permissive object schema for the wire format;
//      runtime Zod parsing in the tool's `execute()` keeps using its
//      original schema. Defense-in-depth for any future tool whose author
//      reaches for a top-level discriminated union.
//   4. SendMessage was refactored to engine's flat-top + nested-union
//      design — top level is `{to, summary, message, run_id}` with
//      `message: string | StructuredMessage`. The schema is now natively
//      Anthropic-compatible: no top-level union to flatten. The flatten
//      helper becomes a no-op for SendMessage; the test below verifies
//      that the resulting wire shape is the engine-style flat-top schema.
//
// This test:
//   - asserts every coordinator tool's serialized shape has
//     `type: 'object'`, AND
//   - asserts the SendMessage shape is the engine-style flat-top schema
//     (no top-level anyOf, properties = {to, summary, message, run_id},
//     required = ['to', 'message']), AND
//   - exercises the `z.preprocess(discriminatedUnion(...))` shape in
//     isolation so the flatten helper still has explicit coverage in case
//     a future tool needs it.

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
  it('emits the engine-style flat-top schema for SendMessage (natively Anthropic-compatible — no flatten workaround needed)', () => {
    const apiTool = toAnthropicTool(asAnyTool(sendMessageTool));
    const schema = apiTool.input_schema as Record<string, unknown>;

    // Anthropic requires top-level type: 'object' AND rejects top-level
    // unions. Both must hold simultaneously.
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('allOf');

    // Engine-style top-level shape: flat object with four properties.
    // The discriminated union (shutdown_request | shutdown_response |
    // plan_approval_response) lives INSIDE the `message` property as a
    // nested anyOf — Anthropic permits unions inside properties, only
    // the top level must be a plain object.
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    if (!props) return;
    expect(Object.keys(props).sort()).toEqual(
      ['message', 'run_id', 'summary', 'to'],
    );

    // `to` and `message` are the only required fields — `summary` and
    // `run_id` are optional.
    expect((schema.required as string[]).sort()).toEqual(['message', 'to']);

    // Sanity: `message` carries the nested string|StructuredMessage union
    // (zod-to-json-schema emits `anyOf`). Anthropic accepts this shape.
    const messageProp = props.message as Record<string, unknown>;
    expect(messageProp).toHaveProperty('anyOf');
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
