// query_product_context — read the founder's product brief
// (name + description + valueProp) for the current (userId, productId).
//
// Called by: content-manager (post_batch mode) and any other agent that
// needs to ground a draft in the founder's product. Mirrors the
// `find_threads` / `query_strategic_path` pattern: zero-arg, scoped to
// ctx, read-only.
//
// This exists because content-manager (and historically the
// now-retired post-writer agent) drafts the body itself in its own LLM
// turn. Earlier the body was generated inside `draft_post` via a
// sideQuery call that read the product row directly. Splitting the
// read out of the persist tool lets the agent see the same brief the
// rules in x-post-voice / reddit-post-voice reference (product name,
// what it does, the value prop).
//
// Returns `null` when the product row is missing — this should not
// happen in practice (every authenticated user has a product) but the
// caller can decide whether to fail loudly or fall back gracefully.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_PRODUCT_CONTEXT_TOOL_NAME = 'query_product_context';

export interface ProductContext {
  name: string;
  description: string;
  valueProp: string | null;
}

export const queryProductContextTool: ToolDefinition<
  Record<string, never>,
  ProductContext | null
> = buildTool({
  name: QUERY_PRODUCT_CONTEXT_TOOL_NAME,
  description:
    'Return the founder\'s product brief (name, description, value prop) ' +
    'for the current product. Call this before drafting a post so the ' +
    'body is grounded in what the product actually does. Read-only, ' +
    'zero-arg, scoped to the current user + product.',
  inputSchema: z.object({}).strict(),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(_input, ctx): Promise<ProductContext | null> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const rows = await db
      .select({
        name: products.name,
        description: products.description,
        valueProp: products.valueProp,
      })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.userId, userId)))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      name: row.name,
      description: row.description,
      valueProp: row.valueProp ?? null,
    };
  },
});
