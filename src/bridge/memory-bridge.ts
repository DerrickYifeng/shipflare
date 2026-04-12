import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Build a product context block for agent system prompts.
 * Following engine's Memory/Dream pattern (engine/memdir/) but
 * sourced from the database instead of filesystem.
 *
 * This is injected into agent system prompts so they know what
 * product they're marketing without requiring tool calls.
 */
export async function loadProductContext(userId: string): Promise<string> {
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    return '';
  }

  const keywords = product.keywords.length > 0
    ? product.keywords.join(', ')
    : 'none specified';

  return [
    '<product-context>',
    `Name: ${product.name}`,
    `URL: ${product.url}`,
    `Description: ${product.description}`,
    product.valueProp ? `Value Proposition: ${product.valueProp}` : null,
    `Keywords: ${keywords}`,
    '</product-context>',
  ].filter(Boolean).join('\n');
}
