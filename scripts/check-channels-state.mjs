/**
 * Diagnostic: channels post_history state + actual FK name on channel_posts.
 *
 * Run: DATABASE_URL="..." node scripts/check-channels-state.mjs
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

try {
  const [counts] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE post_history IS NULL)::int AS null_posthistory,
      COUNT(*) FILTER (WHERE post_history IS NOT NULL AND jsonb_array_length(post_history) = 0)::int AS empty_array,
      COUNT(*) FILTER (WHERE post_history IS NOT NULL AND jsonb_array_length(post_history) > 0)::int AS with_data
    FROM channels
  `;
  console.log('channels state:');
  console.log(`  total:            ${counts.total}`);
  console.log(`  null post_history:${counts.null_posthistory}`);
  console.log(`  empty array:      ${counts.empty_array}`);
  console.log(`  with data:        ${counts.with_data}`);

  const fks = await sql`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'channel_posts'::regclass AND contype = 'f'
  `;
  console.log(`\nchannel_posts FK(s): ${fks.map((f) => f.conname).join(', ') || '(none)'}`);

  if (counts.with_data > 0) {
    const [cpCount] = await sql`SELECT COUNT(*)::int AS n FROM channel_posts`;
    console.log(`\nchannel_posts rows: ${cpCount.n}`);
    if (cpCount.n === 0) {
      console.log('⚠  channels have post_history data but channel_posts is empty — backfill may have been filtered.');
    }
  }
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
