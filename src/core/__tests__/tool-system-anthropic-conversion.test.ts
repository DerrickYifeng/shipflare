// Regression: Anthropic's tool input_schema grammar requires top-level
// `type: 'object'` (see node_modules/@anthropic-ai/sdk/.../messages.d.ts —
// `Tool.InputSchema.type: 'object'` is non-optional). Some Zod constructs
// — notably `z.preprocess(...)` wrapping a discriminated union, which is
// how `SendMessageInputSchema` is built — emit a top-level
// `{ anyOf: [...] }` with NO `type` field. The Anthropic API then rejects
// the request with `tools.N.custom.input_schema.type: Field required`,
// which is exactly the 400 the team-lead (coordinator) processor was
// throwing in the agent-run worker after Phase G landed and the lead's
// tool list started including SendMessage.
//
// This test enumerates every concrete tool a coordinator can carry and
// asserts each one's Anthropic-converted shape has `type: 'object'`. It
// ALSO directly exercises the `z.preprocess(discriminatedUnion(...))`
// shape in isolation so a future contributor adding another preprocess-
// wrapped union schema gets a clear failure pointing at the conversion
// helper, not a runtime 400 from Anthropic.

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
  it("emits top-level type: 'object' for SendMessage (z.preprocess(discriminatedUnion))", () => {
    const apiTool = toAnthropicTool(asAnyTool(sendMessageTool));
    expect(apiTool.input_schema.type).toBe('object');
    // The discriminated-union alternatives must still be present so the
    // API can validate the variant shape.
    const schema = apiTool.input_schema as Record<string, unknown>;
    expect(Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)).toBe(
      true,
    );
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

  it("injects type: 'object' when zod-to-json-schema omits it (preprocess+union case)", () => {
    // Construct the same shape SendMessage uses, in isolation, so the
    // failure mode is unambiguous if the helper regresses.
    const variantA = z.object({
      type: z.literal('a'),
      payload: z.string(),
    });
    const variantB = z.object({
      type: z.literal('b'),
      payload: z.number(),
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
    expect(apiTool.input_schema.type).toBe('object');
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
