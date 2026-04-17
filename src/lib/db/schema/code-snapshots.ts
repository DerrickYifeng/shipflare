import { pgTable, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';

export const codeSnapshots = pgTable(
  'code_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' })
      .unique(),
    repoFullName: text('repo_full_name').notNull(),
    repoUrl: text('repo_url').notNull(),
    techStack: jsonb('tech_stack').notNull(),
    fileTree: jsonb('file_tree').notNull(),
    keyFiles: jsonb('key_files').notNull(),
    scanSummary: text('scan_summary'),
    commitSha: text('commit_sha'),
    diffSummary: text('diff_summary'),
    changesDetected: boolean('changes_detected').default(false),
    lastDiffAt: timestamp('last_diff_at', { mode: 'date' }),
    scannedAt: timestamp('scanned_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [index('code_snapshots_user_idx').on(t.userId)],
);
