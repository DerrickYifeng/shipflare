import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toXaiJsonSchema } from '../json-schema-helper';

describe('toXaiJsonSchema', () => {
  it('forces additionalProperties=false on every object', () => {
    const schema = toXaiJsonSchema(
      z.object({
        a: z.string(),
        b: z.object({ c: z.number() }),
      }),
    );
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    // @ts-expect-error nested object lookup
    expect(schema.properties.b).toMatchObject({ additionalProperties: false });
  });

  it('coerces nullable string to type array ["string", "null"]', () => {
    const schema = toXaiJsonSchema(
      z.object({ a: z.string().nullable() }),
    );
    // @ts-expect-error nested
    const aType = schema.properties.a.type;
    expect(Array.isArray(aType)).toBe(true);
    expect(aType).toEqual(expect.arrayContaining(['string', 'null']));
  });

  it('coerces nullable number to type array ["number", "null"]', () => {
    const schema = toXaiJsonSchema(
      z.object({ a: z.number().nullable() }),
    );
    // @ts-expect-error nested
    const aType = schema.properties.a.type;
    expect(Array.isArray(aType)).toBe(true);
    expect(aType).toEqual(expect.arrayContaining(['number', 'null']));
  });

  it('handles array of objects with nested additionalProperties=false', () => {
    const schema = toXaiJsonSchema(
      z.object({
        items: z.array(z.object({ name: z.string(), value: z.number().nullable() })),
      }),
    );
    // @ts-expect-error nested
    const itemSchema = schema.properties.items.items;
    expect(itemSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(Array.isArray(itemSchema.properties.value.type)).toBe(true);
  });

  it('preserves enum values', () => {
    const schema = toXaiJsonSchema(
      z.object({ kind: z.enum(['a', 'b', 'c']) }),
    );
    // @ts-expect-error nested
    expect(schema.properties.kind.enum).toEqual(['a', 'b', 'c']);
  });

  it('strips $schema and other top-level meta keys xAI does not need', () => {
    const schema = toXaiJsonSchema(z.object({ a: z.string() }));
    expect((schema as Record<string, unknown>).$schema).toBeUndefined();
    expect((schema as Record<string, unknown>).$ref).toBeUndefined();
  });
});
