import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  STRUCTURED_OUTPUT_CORRECTION,
  MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT,
  buildStructuredOutputApiTool,
  getMaxStructuredOutputRetries,
  validateStructuredOutput,
  createStructuredOutputTool,
} from '../StructuredOutputTool';

describe('StructuredOutputTool — buildStructuredOutputApiTool', () => {
  it('emits the canonical tool name and description', () => {
    const schema = z.object({ pillar: z.string() });
    const tool = buildStructuredOutputApiTool(schema);
    expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(tool.description).toMatch(/final structured answer/i);
    expect(tool.description).toMatch(/call this tool once/i);
  });

  it('converts a z.array().min(3) schema without Anthropic grammar sanitization', () => {
    // minItems>1 is one of the constructs output_config.format.schema
    // rejects at compile time but tool input_schema accepts. The whole reason
    // this path exists.
    const schema = z.object({
      bugs: z.array(z.string()).min(3),
    });
    const tool = buildStructuredOutputApiTool(schema);
    const input = tool.input_schema as unknown as {
      properties: { bugs: { minItems?: number } };
    };
    expect(input.properties.bugs.minItems).toBe(3);
  });

  it('preserves z.record (dynamic-key) subtrees that the old sanitizer rejected', () => {
    const schema = z.object({
      metrics: z.record(z.number()),
    });
    const tool = buildStructuredOutputApiTool(schema);
    const input = tool.input_schema as unknown as {
      properties: { metrics: { type: string; additionalProperties?: unknown } };
    };
    expect(input.properties.metrics.type).toBe('object');
    expect(input.properties.metrics.additionalProperties).toBeDefined();
  });

  it('handles deeply nested object schemas without throwing', () => {
    const schema = z.object({
      team: z.object({
        leads: z.array(
          z.object({
            name: z.string(),
            bullets: z.array(z.string()).min(2),
          }),
        ),
      }),
    });
    expect(() => buildStructuredOutputApiTool(schema)).not.toThrow();
  });
});

describe('StructuredOutputTool — validateStructuredOutput', () => {
  it('returns ok with the parsed value on success', () => {
    const schema = z.object({ pillar: z.string(), count: z.number() });
    const result = validateStructuredOutput(schema, {
      pillar: 'growth',
      count: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ pillar: 'growth', count: 3 });
    }
  });

  it('returns a formatted correction message on failure', () => {
    const schema = z.object({ count: z.number().int() });
    const result = validateStructuredOutput(schema, { count: 'three' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Schema validation failed/);
      expect(result.message).toMatch(/count/);
      expect(result.message).toMatch(STRUCTURED_OUTPUT_TOOL_NAME);
    }
  });
});

describe('StructuredOutputTool — getMaxStructuredOutputRetries', () => {
  const originalEnv = process.env.MAX_STRUCTURED_OUTPUT_RETRIES;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
    else process.env.MAX_STRUCTURED_OUTPUT_RETRIES = originalEnv;
  });

  it('defaults to 5 when env var is unset or empty', () => {
    delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
    expect(getMaxStructuredOutputRetries()).toBe(
      MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT,
    );
    expect(MAX_STRUCTURED_OUTPUT_RETRIES_DEFAULT).toBe(5);

    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '';
    expect(getMaxStructuredOutputRetries()).toBe(5);
  });

  it('honors a positive integer override', () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '2';
    expect(getMaxStructuredOutputRetries()).toBe(2);
  });

  it('falls back to the default on invalid values', () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = 'abc';
    expect(getMaxStructuredOutputRetries()).toBe(5);
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '-3';
    expect(getMaxStructuredOutputRetries()).toBe(5);
  });
});

describe('StructuredOutputTool — createStructuredOutputTool cache', () => {
  it('reuses the same compiled apiTool for the same schema reference', () => {
    const schema = z.object({ x: z.number() });
    const first = createStructuredOutputTool(schema);
    const second = createStructuredOutputTool(schema);
    expect(second).toBe(first);
    expect(second.apiTool).toBe(first.apiTool);
  });

  it('issues new entries for a new schema reference', () => {
    const schemaA = z.object({ x: z.number() });
    const schemaB = z.object({ y: z.string() });
    const a = createStructuredOutputTool(schemaA);
    const b = createStructuredOutputTool(schemaB);
    expect(a).not.toBe(b);
    expect(a.apiTool).not.toBe(b.apiTool);
  });
});

describe('StructuredOutputTool — correction text is stable', () => {
  it('mentions the canonical tool name', () => {
    expect(STRUCTURED_OUTPUT_CORRECTION).toContain(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(STRUCTURED_OUTPUT_CORRECTION).toMatch(/MUST/);
  });
});

describe('StructuredOutputTool — direct .tool.execute call', () => {
  it('validates input and returns the structured_output envelope', async () => {
    const schema = z.object({ pillar: z.string() });
    const { tool } = createStructuredOutputTool(schema);
    const abortController = new AbortController();
    const ctx = {
      abortSignal: abortController.signal,
      get<T>(key: string): T {
        throw new Error(`not available: ${key}`);
      },
    };
    const out = (await tool.execute({ pillar: 'growth' }, ctx)) as {
      structured_output: { pillar: string };
    };
    expect(out.structured_output.pillar).toBe('growth');
  });

  it('throws when direct .tool.execute is called with an invalid input', async () => {
    const schema = z.object({ pillar: z.string() });
    const { tool } = createStructuredOutputTool(schema);
    const abortController = new AbortController();
    const ctx = {
      abortSignal: abortController.signal,
      get<T>(key: string): T {
        throw new Error(`not available: ${key}`);
      },
    };
    await expect(
      tool.execute({ pillar: 42 }, ctx),
    ).rejects.toThrow(/validation failed/);
  });
});
