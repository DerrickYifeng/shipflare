/**
 * End-to-end smoke test for the two-stage author filter:
 *   1. Regex rules (classifyAuthorBio) — fast pre-filter
 *   2. Claude Haiku LLM judge (judgeAuthorsWithLLM) — product-aware fallback
 *
 * Run:  bun run scripts/test-author-judge-llm.ts [handle1 handle2 ...]
 */
import { XAIClient } from '@/lib/xai-client';
import { classifyAuthorBio, judgeAuthorsWithLLM } from '@/lib/x-author-filter';

const DEFAULT_HANDLES = [
  'levelsio',
  'dvassallo',
  'jackfriks',
  'thepatwalls',
  'gregisenberg',
  'dickiebush',
  'jspector',
  'nicolascole77',
  'thejustinwelsh', // borderline — sells Creator MBA course
];

const product = {
  name: 'ShipFlare',
  description:
    'Autopilot X/Twitter growth for indie hackers — drafts replies and posts daily so solo founders show up consistently without grinding on social media.',
  valueProp:
    'Save 1–2 hours a day on X engagement while staying authentic — built for indie hackers who ship products, not growth creators selling courses.',
};

const run = async () => {
  const handles = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_HANDLES;

  const xai = new XAIClient();
  const bios = await xai.fetchUserBios(handles);
  console.log(`\nfetched ${bios.length}/${handles.length} bios\n`);

  const bar = '─'.repeat(72);

  // Stage 1 — regex rules
  const stage1: Array<{ handle: string; bio: string | null; ruleMatch: ReturnType<typeof classifyAuthorBio> }> = [];
  for (const h of handles) {
    const entry = bios.find((b) => b.username.toLowerCase() === h.toLowerCase());
    const bio = entry?.bio ?? null;
    stage1.push({ handle: h, bio, ruleMatch: classifyAuthorBio(bio) });
  }

  const ambiguous = stage1
    .filter((s) => !s.ruleMatch.isCompetitor && s.bio)
    .map((s) => ({ username: s.handle, bio: s.bio }));

  console.log(`stage 1 (regex): ${stage1.filter((s) => s.ruleMatch.isCompetitor).length} blocked, ${ambiguous.length} ambiguous → LLM\n`);

  // Stage 2 — LLM judge
  const { verdicts: llmVerdicts, usage } = await judgeAuthorsWithLLM(product, ambiguous);

  const llmByHandle = new Map(llmVerdicts.map((v) => [v.username.toLowerCase(), v]));

  for (const { handle, bio, ruleMatch } of stage1) {
    const llm = llmByHandle.get(handle.toLowerCase());
    const finalVerdict = ruleMatch.isCompetitor
      ? { isCompetitor: true, reason: ruleMatch.reason, by: 'rule' }
      : llm
        ? { isCompetitor: llm.isCompetitor, reason: llm.reason, by: 'llm' }
        : { isCompetitor: false, reason: 'bio unknown', by: 'default' };

    const tag = finalVerdict.isCompetitor ? 'BLOCK' : 'pass ';
    console.log(`${tag} [${finalVerdict.by}] @${handle} — ${finalVerdict.reason}`);
    console.log(`       bio: ${bio ?? '(empty)'}`);
    console.log(bar);
  }

  console.log(`\nLLM cost: $${usage.costUsd.toFixed(4)} (${usage.inputTokens} in / ${usage.outputTokens} out)\n`);
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
