import { pgTable, text, timestamp, boolean, unique } from 'drizzle-orm/pg-core';
import { products } from './products';

/**
 * Agent memories — Supabase-backed replacement for engine's
 * filesystem MEMORY.md + topic .md files.
 *
 * Each memory is a named entry per product with type taxonomy
 * (user, feedback, project, reference).
 */
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    type: text('type').notNull(), // 'user' | 'feedback' | 'project' | 'reference'
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('agent_memories_product_name_unique').on(table.productId, table.name),
  ],
);

/**
 * Agent memory logs — timestamped observations from agent runs.
 * Replaces engine's daily log files (logs/YYYY-MM-DD.md).
 * Consumed by the dream/distillation system.
 */
export const agentMemoryLogs = pgTable('agent_memory_logs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  entry: text('entry').notNull(),
  loggedAt: timestamp('logged_at', { mode: 'date' }).defaultNow().notNull(),
  distilled: boolean('distilled').default(false).notNull(),
});
