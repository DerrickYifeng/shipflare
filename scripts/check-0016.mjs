/**
 * Post-apply state check for 0016_channel_posts.
 *
 * Prints:
 *   (A) channel_posts table exists + row count
 *   (B) per-channel comparison: JSONB length vs table count (first 5 channels with post_history)
 *   (C) orphan check: any channel_posts referencing missing channels (should be 0 due to FK)
 *   (D) CHECK / UNIQUE / INDEX presence
 *
 * Run: DATABASE_URL="..." node scripts/check-0016.mjs
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

try {
  // (A) table exists + row count
  const [tbl] = await sql`
    SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_name = 'channel_posts'
  `;
  if (tbl.n === 0) {
    console.log('(A) channel_posts table: MISSING — migration 0016 was not applied');
    process.exitCode = 1;
  } else {
    const [rows] = await sql`SELECT COUNT(*)::int AS n FROM channel_posts`;
    console.log(`(A) channel_posts table exists, rows: ${rows.n}`);
  }

  // (B) per-channel comparison
  const cmp = await sql`
    SELECT c.id,
           c.platform,
           jsonb_array_length(c.post_history) AS jsonb_count,
           (SELECT COUNT(*)::int FROM channel_posts cp WHERE cp.channel_id = c.id) AS table_count
    FROM channels c
    WHERE c.post_history IS NOT NULL
      AND jsonb_array_length(c.post_history) > 0
    ORDER BY jsonb_array_length(c.post_history) DESC
    LIMIT 5
  `;
  if (cmp.length === 0) {
    console.log('(B) no channels have post_history data — nothing to backfill');
  } else {
    console.log('(B) JSONB vs table count (first 5 channels, largest first):');
    for (const r of cmp) {
      const mark = r.table_count === r.jsonb_count ? 'OK' : r.table_count < r.jsonb_count ? 'FILTERED' : 'OVERFLOW';
      console.log(
        `    ${r.platform.padEnd(8)} ${r.id.slice(0, 8)}... jsonb=${r.jsonb_count} table=${r.table_count}  [${mark}]`,
      );
    }
  }

  // (C) orphan check (should be 0 due to FK ON DELETE CASCADE)
  const [orphans] = await sql`
    SELECT COUNT(*)::int AS n FROM channel_posts cp
    WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = cp.channel_id)
  `;
  console.log(`(C) orphan channel_posts rows (no matching channel): ${orphans.n}  ${orphans.n === 0 ? 'OK' : 'UNEXPECTED'}`);

  // (D) constraints + index
  const constraints = await sql`
    SELECT conname FROM pg_constraint
    WHERE conname IN ('channel_posts_type_chk', 'channel_posts_channel_id_channels_id_fk')
  `;
  console.log(`(D) CHECK + FK constraints: ${constraints.map((c) => c.conname).join(', ') || '(none)'}`);

  const indexes = await sql`
    SELECT indexname FROM pg_indexes
    WHERE indexname IN ('channel_posts_channel_external_uq', 'channel_posts_channel_posted_idx')
  `;
  console.log(`(D) indexes: ${indexes.map((i) => i.indexname).join(', ') || '(none)'}`);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
