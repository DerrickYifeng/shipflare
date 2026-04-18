/**
 * Ad-hoc: demonstrate that voice injection actually changes slot-body output.
 * Seeds two synthetic voice profiles ("builder log / dry" vs "thought leader / crisp"),
 * runs the slot-body skill with each, prints both drafts side by side.
 *
 * Run:
 *   pnpm tsx scripts/test-voice-inject.ts
 *
 * Requires ANTHROPIC_API_KEY in shell env. Does NOT touch the DB.
 */
import 'dotenv/config';
import { join } from 'node:path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { slotBodyOutputSchema, type SlotBodyOutput } from '@/agents/schemas';
import { buildVoiceBlock, type VoiceProfileRow } from '@/lib/voice/inject';

const bar = '─'.repeat(72);

const BASE_INPUT = {
  contentType: 'metric' as const,
  angle: 'claim' as const,
  topic: 'we just shipped a 3-layer AI reply validator that kills draft slop before send',
  thesis: 'AI marketing only earns trust when the tool is willing to reject its own output',
  thesisSource: 'milestone' as const,
  pillar: 'AI reply quality',
  product: {
    name: 'ShipFlare',
    description: 'AI marketing autopilot for indie devs',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['indie hacker', 'buildinpublic', 'SaaS'],
    lifecyclePhase: 'launched',
  },
  recentPostHistory: [],
  priorAnglesThisWeek: [],
  isThread: false,
};

function makeProfile(overrides: Partial<VoiceProfileRow>): VoiceProfileRow {
  return {
    register: 'builder_log',
    pronouns: 'i',
    capitalization: 'sentence',
    emojiPolicy: 'none',
    signatureEmoji: null,
    punctuationSignatures: [],
    humorRegister: [],
    bannedWords: [],
    bannedPhrases: [],
    worldviewTags: [],
    openerPreferences: [],
    closerPolicy: 'silent_stop',
    voiceStrength: 'strict',
    extractedStyleCardMd: null,
    sampleTweets: [],
    ...overrides,
  };
}

const BUILDER_LOG_PROFILE = makeProfile({
  register: 'builder_log',
  pronouns: 'i',
  capitalization: 'lowercase',
  emojiPolicy: 'none',
  humorRegister: ['self_deprecating', 'dry'],
  worldviewTags: ['pro_craft', 'anti_hype'],
  bannedWords: ['leverage', 'delve', 'unlock', 'game-changer', 'revolutionize', 'seamless', 'crucial'],
  bannedPhrases: ['in today\u2019s fast-paced world', 'build in public'],
  openerPreferences: ['Just shipped', 'naked_claim'],
  closerPolicy: 'silent_stop',
  voiceStrength: 'strict',
  extractedStyleCardMd: `# Voice Profile — builder_log
## Cadence
- short. 5-12 word sentences. fragments OK.
- never multi-clause.
## What this founder says all the time
- just shipped X. Y works now.
- broke the thing. fixing it.
- 3 lines. that's the whole feature.
## What this founder will never say
- marketing-speak adjectives
- exclamation points`,
  sampleTweets: [
    { id: 's1', text: 'just shipped. works on my laptop. ship it.', engagement: 120 },
    { id: 's2', text: 'broke prod for 4 minutes. bug was a missing await. worth the laugh.', engagement: 98 },
    { id: 's3', text: 'pricing update. $19/mo instead of $29. i was wrong about the anchor.', engagement: 84 },
    { id: 's4', text: 'the whole feature is one regex. that is embarrassing.', engagement: 76 },
    { id: 's5', text: 'no analytics. no funnel. just the feature. ship.', engagement: 70 },
  ],
});

const THOUGHT_LEADER_PROFILE = makeProfile({
  register: 'thought_leader',
  pronouns: 'we',
  capitalization: 'sentence',
  emojiPolicy: 'none',
  humorRegister: ['none'],
  worldviewTags: ['pro_craft', 'contrarian'],
  bannedWords: ['leverage', 'delve', 'synergy', 'value-add'],
  openerPreferences: ['naked_claim', 'Hot take:'],
  closerPolicy: 'payoff',
  voiceStrength: 'strict',
  extractedStyleCardMd: `# Voice Profile — thought_leader
## Cadence
- complete sentences, mid-length (12-25 words).
- often sets up with a principle then pays off with a concrete case.
## What this founder says all the time
- The real lesson from X is that Y...
- Most teams conflate X with Y. These are distinct problems.
- The second-order effect of X is what most miss.
## What this founder will never say
- emojis
- "just shipped" phrasing
- self-deprecation`,
  sampleTweets: [
    { id: 's1', text: 'The second-order effect of automation is not speed. It is the cost of trusting a system that does not know when to stop.', engagement: 180 },
    { id: 's2', text: 'Most teams conflate reliability with uptime. These are distinct problems. Uptime measures availability; reliability measures whether the system is useful when available.', engagement: 150 },
    { id: 's3', text: 'The hardest question in AI product design is not what the model can do. It is when it should refuse.', engagement: 140 },
  ],
});

const SKILL = loadSkill(join(process.cwd(), 'src/skills/slot-body'));

async function runWithProfile(label: string, profile: VoiceProfileRow) {
  const voiceBlock = buildVoiceBlock(profile, { seed: 42, sampleCount: 5 });
  console.log(`\n${bar}\n${label}\n${bar}`);
  if (voiceBlock) {
    console.log('Voice block (first 400 chars):');
    console.log(voiceBlock.slice(0, 400) + (voiceBlock.length > 400 ? '…' : ''));
    console.log();
  }

  const result = await runSkill<SlotBodyOutput>({
    skill: SKILL,
    input: { ...BASE_INPUT, voiceBlock },
    deps: {},
    outputSchema: slotBodyOutputSchema,
    runId: `voice-smoke-${label}-${Date.now()}`,
  });

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const e of result.errors) console.error(`  - ${e.label}: ${e.error}`);
    return null;
  }

  const body = result.results[0];
  if (!body) return null;

  console.log('Generated tweet:');
  for (const t of body.tweets) console.log(`  ${t}`);
  console.log(`\nwhyItWorks: ${body.whyItWorks}`);
  console.log(`confidence: ${body.confidence}`);
  console.log(`cost: $${result.usage.costUsd.toFixed(4)}  tokens: ${result.usage.inputTokens}→${result.usage.outputTokens}`);

  // Structural checks
  const tweet = body.tweets.join(' ');
  const lower = tweet.toLowerCase();
  const hits: string[] = [];
  for (const banned of profile.bannedWords) {
    if (lower.includes(banned.toLowerCase())) hits.push(banned);
  }
  console.log(`\nBanned-word violations: ${hits.length === 0 ? 'none ✓' : hits.join(', ') + ' ✗'}`);

  if (profile.capitalization === 'lowercase') {
    const hasUpper = /[A-Z]/.test(tweet);
    console.log(`All-lowercase honored: ${!hasUpper ? 'yes ✓' : 'no ✗ (' + (tweet.match(/[A-Z]/g) ?? []).join('') + ')'}`);
  }

  return body;
}

const run = async () => {
  console.log(`Voice injection smoke test — same topic, two profiles, compare outputs.`);
  console.log(`Topic: "${BASE_INPUT.topic}"`);
  console.log(`Thesis: "${BASE_INPUT.thesis}"`);

  const a = await runWithProfile('Profile A: builder_log / lowercase / dry', BUILDER_LOG_PROFILE);
  const b = await runWithProfile('Profile B: thought_leader / complete sentences', THOUGHT_LEADER_PROFILE);

  console.log(`\n${bar}\nComparison summary`);
  console.log(bar);
  if (a && b) {
    const aText = a.tweets.join(' ');
    const bText = b.tweets.join(' ');
    console.log(`A length: ${aText.length}, B length: ${bText.length}`);
    const same = aText.trim() === bText.trim();
    console.log(`Outputs identical: ${same ? 'YES — voice had no effect ✗' : 'NO — voice differentiated outputs ✓'}`);
  }

  process.exit(0);
};

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
