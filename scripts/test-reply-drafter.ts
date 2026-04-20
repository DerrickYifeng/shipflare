/**
 * Ad-hoc: exercise the reply-drafter skill on hardcoded test tweets to see
 * what the current x-reply-rules + reply-drafter prompts produce.
 *
 * Run:
 *   bun run scripts/test-reply-drafter.ts
 *
 * Requires ANTHROPIC_API_KEY in env. Does not touch the DB.
 */
import { join } from 'node:path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { replyDrafterOutputSchema } from '@/agents/schemas';

const replyDraftSkill = loadSkill(
  join(process.cwd(), 'src/skills/draft-single-reply'),
);

const tweets = [
  {
    tweetId: 't1',
    tweetText: 'killed our onboarding flow, retention went up 40%',
    authorUsername: 'indie_maker',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['buildinpublic', 'saas'],
  },
  {
    tweetId: 't2',
    tweetText: 'GPT-5 pricing just dropped',
    authorUsername: 'ai_watcher',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['ai', 'saas'],
  },
  {
    tweetId: 't3',
    tweetText: 'hiring my first engineer — what should I look for?',
    authorUsername: 'seed_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['startup', 'hiring'],
  },
  {
    tweetId: 't4',
    tweetText: 'finally hit $10k MRR 🎉',
    authorUsername: 'solo_dev',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['mrr', 'buildinpublic'],
  },
  {
    tweetId: 't5',
    tweetText:
      'thinking about raising a seed round. traction is decent but not great. worth the pitch grind?',
    authorUsername: 'stealth_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['fundraising'],
  },
  // register 2 — vulnerable
  {
    tweetId: 't6',
    tweetText: "first big churn today. user I was proud of. genuinely gutted.",
    authorUsername: 'small_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['churn', 'saas'],
  },
  // register 4 — hot take
  {
    tweetId: 't7',
    tweetText: 'onboarding flows are mostly cope. ship users straight to the product.',
    authorUsername: 'opinion_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['saas', 'ux'],
  },
  // register 5 — announcement
  {
    tweetId: 't8',
    tweetText:
      'v2 shipped today. new dashboard, keyboard shortcuts everywhere, CSV export for everything.',
    authorUsername: 'launching_today',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['launch'],
  },
  // register 6 — advice thread
  {
    tweetId: 't9',
    tweetText:
      '3 things I would do differently shipping a SaaS:\n1. charge from day 1\n2. narrower ICP\n3. kill the free tier',
    authorUsername: 'advice_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['saas', 'pricing'],
  },
  // register 7 — humor
  {
    tweetId: 't10',
    tweetText: 'indie hackers when the LLM replies to its own reply',
    authorUsername: 'meme_dev',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['ai', 'humor'],
  },
  // register 8 — growth-bait (brutal-truth format)
  {
    tweetId: 't11',
    tweetText:
      "6 months building. 0 users. here's the brutal truth: you didn't ship fast enough. 🧵",
    authorUsername: 'growth_guru',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['growth'],
  },
  // register 8 — growth-bait (you-keep-doing-X format)
  {
    tweetId: 't12',
    tweetText:
      "you keep shipping features. nobody cares. here's what actually works →",
    authorUsername: 'playbook_founder',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['growth', 'marketing'],
  },
  // register 8 — growth-bait disguised as vulnerable
  {
    tweetId: 't13',
    tweetText:
      'spent 2 years and $50k on my SaaS. 12 users. the hard truth nobody tells you: you are the problem.',
    authorUsername: 'truth_bomber',
    productName: 'ShipFlare',
    productDescription: 'autopilot twitter growth for indie hackers',
    valueProp: 'drafts replies and posts so you show up daily',
    keywords: ['saas', 'founder'],
  },
];

const bar = '─'.repeat(72);

const run = async () => {
  console.log(`\nRunning reply-drafter on ${tweets.length} test tweets…\n${bar}`);

  const result = await runSkill({
    skill: replyDraftSkill,
    input: { tweets },
    deps: {}, // drafter's x_get_tweet / x_search tools not needed for self-contained tweets
    outputSchema: replyDrafterOutputSchema,
    runId: `test-${Date.now()}`,
  });

  for (let i = 0; i < result.results.length; i++) {
    const t = tweets[i];
    const r = result.results[i];
    const reply = r.replyText ?? '';
    console.log(`\n[${i + 1}] @${t.authorUsername}: ${t.tweetText}`);
    console.log(`    reply   (${reply.length} chars, conf ${r.confidence}): ${reply}`);
    console.log(`    strategy: ${r.strategy}`);
    if (r.whyItWorks) console.log(`    whyItWorks: ${r.whyItWorks}`);
  }

  if (result.errors.length > 0) {
    console.log(`\n${bar}\nErrors:`);
    for (const e of result.errors) console.log(`  - ${e.label}: ${e.error}`);
  }

  console.log(
    `\n${bar}\nTotal cost: $${result.usage.costUsd.toFixed(4)} • ${result.usage.inputTokens} in / ${result.usage.outputTokens} out\n`,
  );
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
