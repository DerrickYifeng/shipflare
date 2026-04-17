/**
 * Ad-hoc: fetch REAL recent tweets from a list of indie-hacker handles via
 * xAI Grok search, then run them through the reply-drafter skill.
 *
 * Run:
 *   bun run scripts/test-reply-drafter-real.ts [handle1 handle2 ...]
 *
 * Defaults to a curated indie-hacker handle list if no args.
 */
import { join } from 'node:path';
import { XAIClient } from '@/lib/xai-client';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { replyDrafterOutputSchema } from '@/agents/schemas';

const DEFAULT_HANDLES = [
  'levelsio',
  'marc_louvion',
  'dvassallo',
  'jackfriks',
];
const TWEETS_PER_HANDLE = 3;

const replyScanSkill = loadSkill(
  join(process.cwd(), 'src/skills/reply-scan'),
);

const bar = '─'.repeat(72);

const run = async () => {
  const handles = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_HANDLES;

  const xaiClient = new XAIClient();

  console.log(`Fetching ~${TWEETS_PER_HANDLE} recent tweets per handle from: ${handles.join(', ')}`);
  console.log(bar);

  type Candidate = {
    tweetId: string;
    tweetText: string;
    authorUsername: string;
    productName: string;
    productDescription: string;
    valueProp: string;
    keywords: string[];
  };

  const tweets: Candidate[] = [];

  for (const handle of handles) {
    try {
      const result = await xaiClient.searchTweets(
        `from:${handle} -is:retweet -is:reply`,
        { maxResults: TWEETS_PER_HANDLE + 3 },
      );
      const picked = result.tweets.slice(0, TWEETS_PER_HANDLE);
      for (const t of picked) {
        tweets.push({
          tweetId: t.url.split('/').pop() ?? `${handle}-${tweets.length}`,
          tweetText: t.text,
          authorUsername: t.authorUsername ?? handle,
          productName: 'ShipFlare',
          productDescription: 'autopilot twitter growth for indie hackers',
          valueProp: 'drafts replies and posts so you show up daily',
          keywords: ['indiehackers', 'buildinpublic'],
        });
      }
      console.log(`  @${handle}: fetched ${picked.length} tweets`);
    } catch (err) {
      console.error(`  @${handle}: FAILED — ${(err as Error).message}`);
    }
  }

  if (tweets.length === 0) {
    console.error('No tweets to draft replies for.');
    process.exit(1);
  }

  console.log(`\nRunning reply-drafter on ${tweets.length} real tweets…\n${bar}`);

  const result = await runSkill({
    skill: replyScanSkill,
    input: { tweets },
    deps: { xaiClient },
    outputSchema: replyDrafterOutputSchema,
    runId: `test-real-${Date.now()}`,
  });

  for (let i = 0; i < result.results.length; i++) {
    const t = tweets[i];
    const r = result.results[i];
    const reply = r.replyText ?? '';
    const preview = t.tweetText.replace(/\s+/g, ' ').slice(0, 220);
    console.log(
      `\n[${i + 1}] @${t.authorUsername}: ${preview}${t.tweetText.length > 220 ? '…' : ''}`,
    );
    console.log(
      `    reply   (${reply.length} chars, conf ${r.confidence}): ${reply}`,
    );
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
