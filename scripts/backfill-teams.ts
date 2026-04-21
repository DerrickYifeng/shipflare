/**
 * One-shot backfill: provision an AI team for every product that pre-dates
 * the Phase F auto-provisioner.
 *
 * Idempotent: products that already have a linked `teams` row are skipped.
 * Re-running after a partial run resumes from the missing set.
 *
 * Run:
 *   pnpm tsx scripts/backfill-teams.ts            # dry-run (default)
 *   pnpm tsx scripts/backfill-teams.ts --commit   # apply
 *
 * Requires DATABASE_URL in env.
 */
import 'dotenv/config';
import { inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, teams } from '@/lib/db/schema';
import { provisionTeamForProduct } from '@/lib/team-provisioner';

interface BackfillSummary {
  scanned: number;
  alreadyHadTeam: number;
  wouldProvision: number;
  provisioned: number;
  failed: number;
  failures: Array<{ productId: string; userId: string; error: string }>;
}

async function main() {
  const commit = process.argv.includes('--commit');

  const summary: BackfillSummary = {
    scanned: 0,
    alreadyHadTeam: 0,
    wouldProvision: 0,
    provisioned: 0,
    failed: 0,
    failures: [],
  };

  console.log(
    `[backfill-teams] mode=${commit ? 'commit' : 'dry-run'} starting...`,
  );

  // Pull every product + a left-join onto teams(product_id). We stream via
  // offset + limit in case the table grows larger than memory allows in
  // one fetch; 500 rows/batch is conservative for this one-shot script.
  const BATCH = 500;
  let offset = 0;

  while (true) {
    const rows = await db
      .select({ id: products.id, userId: products.userId })
      .from(products)
      .orderBy(products.id)
      .limit(BATCH)
      .offset(offset);

    if (rows.length === 0) break;

    const productIds = rows.map((r) => r.id);
    const existingTeams = productIds.length
      ? await db
          .select({ productId: teams.productId })
          .from(teams)
          .where(inArray(teams.productId, productIds))
      : [];
    const productsWithTeam = new Set(
      existingTeams
        .map((t) => t.productId)
        .filter((v): v is string => v != null),
    );

    for (const row of rows) {
      summary.scanned += 1;

      if (productsWithTeam.has(row.id)) {
        summary.alreadyHadTeam += 1;
        continue;
      }

      if (!commit) {
        summary.wouldProvision += 1;
        console.log(
          `[dry-run] would provision product=${row.id} user=${row.userId}`,
        );
        continue;
      }

      try {
        const provision = await provisionTeamForProduct(row.userId, row.id);
        summary.provisioned += 1;
        console.log(
          `[commit] product=${row.id} user=${row.userId} team=${provision.teamId} preset=${provision.preset} members=${provision.membersInserted}`,
        );
      } catch (err) {
        summary.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        summary.failures.push({
          productId: row.id,
          userId: row.userId,
          error: message,
        });
        console.error(
          `[commit] FAILED product=${row.id} user=${row.userId}: ${message}`,
        );
      }
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  console.log('---');
  console.log(`[backfill-teams] summary:`);
  console.log(`  scanned          : ${summary.scanned}`);
  console.log(`  already had team : ${summary.alreadyHadTeam}`);
  if (commit) {
    console.log(`  provisioned      : ${summary.provisioned}`);
    console.log(`  failed           : ${summary.failed}`);
    if (summary.failures.length > 0) {
      console.log('  failures:');
      for (const f of summary.failures) {
        console.log(`    - ${f.productId} (${f.userId}): ${f.error}`);
      }
    }
  } else {
    console.log(`  would provision  : ${summary.wouldProvision}`);
    console.log('');
    console.log('  Re-run with --commit to apply.');
  }

  // Force-close open DB connections so the process exits.
  await db.execute(sql`SELECT 1`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-teams] unhandled error:', err);
  process.exit(2);
});
