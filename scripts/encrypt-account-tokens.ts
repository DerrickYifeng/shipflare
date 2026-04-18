/**
 * One-shot backfill: encrypt any plaintext OAuth tokens left in the `accounts`
 * table after the rollout of `src/lib/auth/index.ts` adapter wrapping.
 *
 * Idempotent: rows already in `iv:tag:ciphertext` form are skipped.
 *
 * Run:
 *   bun run scripts/encrypt-account-tokens.ts
 *
 * Requires DATABASE_URL and ENCRYPTION_KEY in env. Dry-run by default; pass
 * `--commit` to actually write.
 */
import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import { encrypt, isEncrypted } from '@/lib/encryption';

const TOKEN_FIELDS = ['access_token', 'refresh_token', 'id_token'] as const;

async function main() {
  const commit = process.argv.includes('--commit');
  const rows = await db.select().from(accounts);

  let scanned = 0;
  let updated = 0;
  let alreadyOk = 0;

  for (const row of rows) {
    scanned += 1;
    const patch: Partial<Record<(typeof TOKEN_FIELDS)[number], string>> = {};
    let changed = false;

    for (const field of TOKEN_FIELDS) {
      const v = row[field as keyof typeof row] as string | null | undefined;
      if (!v) continue;
      if (isEncrypted(v)) continue;
      patch[field] = encrypt(v);
      changed = true;
    }

    if (!changed) {
      alreadyOk += 1;
      continue;
    }

    if (commit) {
      await db
        .update(accounts)
        .set(patch)
        .where(
          and(
            eq(accounts.provider, row.provider),
            eq(accounts.providerAccountId, row.providerAccountId),
          ),
        );
    }

    updated += 1;
    const fields = Object.keys(patch).join(', ');
    console.log(
      `${commit ? 'encrypted' : 'would encrypt'}: provider=${row.provider} userId=${row.userId} fields=${fields}`,
    );
  }

  console.log('---');
  console.log(`scanned=${scanned} updated=${updated} already_encrypted=${alreadyOk}`);
  if (!commit) {
    console.log('DRY RUN. Re-run with --commit to apply.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
