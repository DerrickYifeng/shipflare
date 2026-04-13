import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';

/**
 * Build a product context block for agent system prompts.
 * Sourced from the database.
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
    product.url ? `URL: ${product.url}` : null,
    `Description: ${product.description}`,
    product.valueProp ? `Value Proposition: ${product.valueProp}` : null,
    `Keywords: ${keywords}`,
    '</product-context>',
  ].filter(Boolean).join('\n');
}

/**
 * Load full context: product info + agent memory.
 * Merges DB product context with Supabase-backed agent memory
 * into a single system prompt block.
 */
export async function loadFullContext(
  userId: string,
  productId: string,
): Promise<string> {
  const productContext = await loadProductContext(userId);
  const store = new MemoryStore(productId);
  const memoryPrompt = await buildMemoryPrompt(store);

  const parts = [productContext, memoryPrompt].filter(Boolean);
  return parts.join('\n\n');
}
