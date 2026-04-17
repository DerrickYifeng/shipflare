/**
 * Smoke test for xAIClient.fetchUserBios + classifyAuthorBio.
 * Prints raw bio + classification verdict for each handle.
 *
 * Run:  bun run scripts/test-author-filter.ts [handle1 handle2 ...]
 */
import { XAIClient } from '@/lib/xai-client';
import { classifyAuthorBio } from '@/lib/x-author-filter';

const DEFAULT_HANDLES = [
  'levelsio',       // genuine indie hacker — should pass
  'dvassallo',      // genuine founder — should pass
  'jackfriks',      // genuine indie hacker — should pass
  'thepatwalls',    // indie hackers founder — should pass
  'gregisenberg',   // borderline — founder but also heavy "community/playbook" energy
  'dickiebush',     // growth/ghostwriter energy — likely flagged
  'jspector',       // random — depends on bio
];

const run = async () => {
  const handles = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_HANDLES;

  const xai = new XAIClient();
  const bios = await xai.fetchUserBios(handles);

  console.log(`\nfetched ${bios.length}/${handles.length} bios\n`);

  const bar = '─'.repeat(72);
  for (const handle of handles) {
    const entry = bios.find(
      (b) => b.username.toLowerCase() === handle.toLowerCase(),
    );
    if (!entry) {
      console.log(`@${handle}: UNKNOWN (not resolved by Grok)`);
      continue;
    }
    const verdict = classifyAuthorBio(entry.bio);
    const tag = verdict.isCompetitor ? `BLOCK (${verdict.reason})` : 'pass';
    console.log(`@${handle} — ${tag}`);
    console.log(
      `  followers: ${entry.followerCount ?? 'unknown'}\n  bio: ${entry.bio ?? '(empty)'}`,
    );
    console.log(bar);
  }
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
