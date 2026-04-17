/**
 * Post-apply state check for 0015_agent_memories_user_id.
 *
 * Prints:
 *   (A) whether agent_memories.user_id is NOT NULL
 *   (B) orphan count (rows with NULL user_id — only queried if column is nullable)
 *   (C) FK + index presence
 *
 * Run: DATABASE_URL="..." node scripts/check-0015.mjs
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

try {
  const [col] = await sql`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'agent_memories' AND column_name = 'user_id'
  `;

  if (!col) {
    console.log('(A) user_id column: MISSING — migration 0015 was not applied');
    process.exitCode = 1;
  } else {
    console.log(
      `(A) user_id is_nullable: ${col.is_nullable}  ${
        col.is_nullable === 'NO'
          ? '→ clean env, SET NOT NULL applied'
          : '→ orphans exist, column left NULLABLE'
      }`,
    );

    if (col.is_nullable === 'YES') {
      const [orphan] = await sql`
        SELECT COUNT(*)::int AS n FROM agent_memories WHERE user_id IS NULL
      `;
      console.log(`(B) orphan rows: ${orphan.n}`);
      if (orphan.n > 0) {
        const sample = await sql`
          SELECT id, product_id FROM agent_memories
          WHERE user_id IS NULL LIMIT 5
        `;
        console.log('    first up to 5:');
        for (const r of sample) {
          console.log(`      id=${r.id}  product_id=${r.product_id}`);
        }
      }
    }
  }

  const fks = await sql`
    SELECT conname FROM pg_constraint
    WHERE conname = 'agent_memories_user_id_users_id_fk'
  `;
  console.log(`(C) FK agent_memories_user_id_users_id_fk: ${fks.length > 0 ? 'present' : 'MISSING'}`);

  const idx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE indexname = 'agent_memories_user_idx'
  `;
  console.log(`(C) index agent_memories_user_idx: ${idx.length > 0 ? 'present' : 'MISSING'}`);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
