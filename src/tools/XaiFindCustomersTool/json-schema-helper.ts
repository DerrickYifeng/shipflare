/**
 * Convert a Zod schema to xAI-strict-mode-compatible JSON Schema.
 *
 * xAI's structured-outputs feature with `strict: true` requires:
 *  - `additionalProperties: false` on every `type: object`
 *  - Nullables expressed as type arrays (`{"type": ["string", "null"]}`)
 *    rather than `{"type": "string", "nullable": true}` or `anyOf` with null
 *  - No array-form `items` (single subschema only)
 *  - No `$schema` / `$id` / `$ref` to external sources
 *
 * `zod-to-json-schema` v3.25+ emits valid JSON Schema 7 output that already
 * satisfies most of these constraints: it uses type arrays for nullables and
 * sets `additionalProperties: false` on object schemas by default. This helper
 * post-processes the output to strip meta keys xAI rejects and to guard against
 * any edge cases where `additionalProperties` is not already set to `false`.
 *
 * Reference: https://docs.x.ai/developers/model-capabilities/text/structured-outputs
 */

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Recursively walk a JSON Schema node and apply xAI-strict transforms. */
function transform(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return node;
  }

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Strip meta keys xAI does not need / rejects.
    if (key === '$schema' || key === '$ref' || key === '$id') continue;

    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = transform(propSchema);
      }
      out[key] = props;
      continue;
    }

    if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = transform(value);
      continue;
    }

    if (key === 'anyOf' && Array.isArray(value)) {
      // Detect the nullable pattern: anyOf: [{type: 'X'}, {type: 'null'}]
      // and collapse to {type: ['X', 'null']} (or wider type array).
      const variants = value
        .map((v) => transform(v))
        .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object');
      const types = new Set<string>();
      let collapsible = true;
      for (const v of variants) {
        const t = (v as Record<string, unknown>).type;
        if (typeof t === 'string') {
          types.add(t);
        } else if (Array.isArray(t)) {
          for (const x of t) if (typeof x === 'string') types.add(x);
        } else {
          collapsible = false;
          break;
        }
        // Reject collapse if the variant has any other distinguishing field.
        const otherKeys = Object.keys(v).filter((k) => k !== 'type');
        if (otherKeys.length > 0) {
          collapsible = false;
          break;
        }
      }
      if (collapsible && types.size > 0) {
        out.type = Array.from(types);
        // Don't carry anyOf when we collapsed it.
        continue;
      }
      // Couldn't collapse — pass anyOf through (xAI accepts single-subschema
      // anyOf; multi-subschema is an open xAI limitation we'll surface at
      // request time).
      out[key] = variants;
      continue;
    }

    out[key] = transform(value);
  }

  // For object-typed schemas, force additionalProperties=false unless the
  // caller explicitly opted into open schemas via z.object({}).passthrough().
  if (out.type === 'object' && out.additionalProperties !== true) {
    out.additionalProperties = false;
  }

  return out;
}

export function toXaiJsonSchema(schema: z.ZodTypeAny): object {
  const raw = zodToJsonSchema(schema, { target: 'jsonSchema7' });
  return transform(raw) as object;
}
