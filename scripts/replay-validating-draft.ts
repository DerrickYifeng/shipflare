/**
 * One-shot replay: take every pending draft in the database, push it
 * through the current `reviewing-drafts` (later `validating-draft`)
 * skill, and emit a JSON report of verdicts. Used to capture the
 * pre-migration baseline (Phase A) and the post-migration outcome
 * (Phase B) for direct comparison.
 *
 * Usage:
 *   bun run scripts/replay-validating-draft.ts [--limit=N] [--out=path.json]
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { drafts, threads, products } from '@/lib/db/schema';
import { runForkSkill } from '@/skills/run-fork-skill';
import { reviewingDraftsOutputSchema } from '@/skills/reviewing-drafts/schema';

interface ReplayRow {
  draftId: string;
  threadId: string;
  platform: string;
  community: string;
  draftType: string;
  replyBody: string;
  verdict: string;
  score: number;
  issues: unknown[];
}

const LIMIT = Number(
  process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50',
);
const OUT =
  process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ??
  `replay-${new Date().toISOString().slice(0, 10)}.json`;

async function main(): Promise<void> {
  const rows = await db
    .select({
      draftId: drafts.id,
      userId: drafts.userId,
      threadId: drafts.threadId,
      replyBody: drafts.replyBody,
      confidence: drafts.confidenceScore,
      draftType: drafts.draftType,
      whyItWorks: drafts.whyItWorks,
    })
    .from(drafts)
    .where(eq(drafts.status, 'pending'))
    .limit(LIMIT);

  const out: ReplayRow[] = [];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, row.threadId))
      .limit(1);
    if (!thread) continue;

    // For the baseline run we don't have productId on the draft —
    // pull from the user's first product as a best-effort.
    const [product] = await db.select().from(products).limit(1);
    if (!product) continue;

    const args = JSON.stringify({
      drafts: [
        {
          replyBody: row.replyBody,
          threadTitle: thread.title,
          threadBody: thread.body ?? '',
          subreddit: thread.community,
          productName: product.name,
          productDescription: product.description,
          confidence: row.confidence,
          whyItWorks: row.whyItWorks ?? '',
        },
      ],
      memoryContext: '',
    });

    try {
      const { result, usage } = await runForkSkill(
        'reviewing-drafts',
        args,
        reviewingDraftsOutputSchema,
      );
      out.push({
        draftId: row.draftId,
        threadId: row.threadId,
        platform: thread.platform,
        community: thread.community,
        draftType: row.draftType,
        replyBody: row.replyBody,
        verdict: result.verdict,
        score: result.score,
        issues: result.issues,
      });
      if (usage) {
        totalCostUsd += usage.costUsd ?? 0;
        totalInputTokens += usage.inputTokens ?? 0;
        totalOutputTokens += usage.outputTokens ?? 0;
      }
      succeeded += 1;
      console.log(
        `[${row.draftId}] verdict=${result.verdict} score=${result.score.toFixed(2)}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[${row.draftId}] replay failed:`, err);
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} verdicts to ${OUT}`);
  console.log(
    `Replayed: ${rows.length} | succeeded: ${succeeded} | failed: ${failed}`,
  );
  console.log(
    `Total tokens: in=${totalInputTokens} out=${totalOutputTokens} | est cost: $${totalCostUsd.toFixed(4)}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
