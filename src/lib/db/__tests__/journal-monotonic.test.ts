/**
 * Guard against the silent migration-skip footgun in drizzle-orm's pg-core
 * migrator. The migrator uses `Number(lastDbMigration.created_at) < migration.folderMillis`
 * to decide whether to apply each pending migration. If a later-idx migration
 * has an earlier `when` than an already-applied one, it gets SILENTLY SKIPPED
 * — no warning, no error, just missing tables in production that show up
 * later as "relation X does not exist" failures on the NEXT migration.
 *
 * (See node_modules/drizzle-orm/pg-core/dialect.js → `async migrate`.)
 *
 * The fix is to keep `when` strictly increasing with `idx`. drizzle-kit
 * uses Date.now() at generation time, which usually does the right thing —
 * but out-of-order generation (revert + regenerate, hand-edited timestamps,
 * branches landing in unexpected order) can break monotonicity without
 * anyone noticing until prod fails.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

describe('drizzle migration journal', () => {
  const journalPath = path.resolve(
    process.cwd(),
    'drizzle/meta/_journal.json',
  );
  const journal: Journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

  it('has entries sorted by idx ascending', () => {
    const idxs = journal.entries.map((e) => e.idx);
    const sorted = [...idxs].sort((a, b) => a - b);
    expect(idxs).toEqual(sorted);
  });

  it('has strictly increasing `when` values with idx', () => {
    const violations: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      if (curr.when <= prev.when) {
        violations.push(
          `idx=${curr.idx} (${curr.tag}) when=${curr.when} is NOT > idx=${prev.idx} (${prev.tag}) when=${prev.when}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
