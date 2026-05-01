// Zod frontmatter schema. Aligned with Anthropic platform spec
// (name + description required) plus CC engine extensions (context,
// allowed-tools, model, maxTurns, when-to-use, argument-hint, paths).
//
// Unknown fields pass through (forwards-compat). Loader callers may log
// a warning when unknown keys appear so authoring drift is visible.

import { z } from 'zod';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);

export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64, 'Skill name max 64 chars')
      .regex(/^[a-z0-9_-]+$/, 'Skill name must be [a-z0-9_-]+')
      .refine(
        (n) => !RESERVED_NAMES.has(n),
        'Skill name cannot be "anthropic" or "claude" (Anthropic spec)',
      ),
    description: z
      .string()
      .min(1)
      .max(1024, 'Skill description max 1024 chars'),
    context: z.enum(['inline', 'fork']).optional(),
    'allowed-tools': z.array(z.string()).optional(),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    'when-to-use': z.string().optional(),
    'argument-hint': z.string().optional(),
    paths: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
