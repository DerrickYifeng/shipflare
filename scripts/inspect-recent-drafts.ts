/**
 * Read-only: print recent draft replies + their thread bodies so we can
 * audit the voice/encouragement bar.
 */
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const sql = postgres(url);
  try {
    const rows = await sql<
      Array<{
        id: string;
        status: string;
        draft_type: string;
        platform: string;
        thread_url: string | null;
        thread_body: string | null;
        thread_author: string | null;
        reply_body: string;
        why_it_works: string | null;
        confidence_score: number;
        review_verdict: string | null;
        review_score: number | null;
        created_at: Date;
      }>
    >`
      SELECT d.id, d.status, d.draft_type, t.platform,
             t.url AS thread_url, t.body AS thread_body, t.author AS thread_author,
             d.reply_body, d.why_it_works,
             d.confidence_score, d.review_verdict, d.review_score,
             d.created_at
      FROM drafts d
      JOIN threads t ON t.id = d.thread_id
      WHERE d.draft_type = 'reply'
      ORDER BY d.created_at DESC
      LIMIT 30
    `;
    for (const r of rows) {
      console.log('---');
      console.log(`id=${r.id} status=${r.status} platform=${r.platform} created=${r.created_at.toISOString()}`);
      console.log(`thread_url=${r.thread_url}`);
      console.log(`thread_author=${r.thread_author}`);
      console.log(`thread_body: ${(r.thread_body ?? '').slice(0, 400)}`);
      console.log(`reply_body: ${r.reply_body}`);
      console.log(`why_it_works: ${r.why_it_works ?? ''}`);
      console.log(
        `confidence=${r.confidence_score} verdict=${r.review_verdict ?? '-'} score=${r.review_score ?? '-'}`,
      );
    }
    console.log(`\n(total ${rows.length} rows)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
