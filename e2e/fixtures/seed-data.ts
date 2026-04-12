const SUBREDDITS = ['webdev', 'SaaS', 'indiehackers', 'startups', 'programming'];

const EVENT_TYPES = [
  'draft_approved',
  'draft_skipped',
  'post_published',
  'thread_discovered',
  'health_score_updated',
];

export function makeThread(userId: string, index: number) {
  const subreddit = SUBREDDITS[index % SUBREDDITS.length];
  return {
    id: crypto.randomUUID(),
    userId,
    externalId: `t3_test${index}`,
    platform: 'reddit' as const,
    subreddit,
    title: `How do you handle ${['SEO', 'marketing', 'user acquisition', 'pricing', 'onboarding'][index % 5]} for your SaaS?`,
    url: `https://reddit.com/r/${subreddit}/comments/test${index}`,
    body: `Looking for advice on ${subreddit} strategies.`,
    author: `user${index}`,
    upvotes: 10 + index * 5,
    commentCount: 3 + index,
    relevanceScore: 0.6 + (index % 4) * 0.1,
    discoveredAt: new Date(),
  };
}

export function makeDraft(userId: string, threadId: string, index: number) {
  return {
    id: crypto.randomUUID(),
    userId,
    threadId,
    status: 'pending' as const,
    replyBody: `Great question! I built ShipFlare to help with exactly this. Here's what worked for us: focus on organic Reddit engagement to drive qualified traffic. Happy to share more details if helpful.`,
    confidenceScore: 0.7 + (index % 3) * 0.05,
    whyItWorks: `This reply addresses the user's specific pain point about ${['SEO', 'marketing', 'growth'][index % 3]} and naturally introduces the product as a solution without being pushy.`,
    ftcDisclosure: 'Disclosure: I built ShipFlare',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function makeHealthScore(userId: string, score: number) {
  return {
    id: crypto.randomUUID(),
    userId,
    score,
    s1Pipeline: score * 0.2,
    s2Quality: score * 0.22,
    s3Engagement: score * 0.18,
    s4Consistency: score * 0.2,
    s5Safety: score * 0.2,
    calculatedAt: new Date(),
  };
}

export function makeActivityEvent(userId: string, index: number) {
  const eventType = EVENT_TYPES[index % EVENT_TYPES.length];
  return {
    id: crypto.randomUUID(),
    userId,
    eventType,
    metadataJson: { source: 'e2e-test', index },
    createdAt: new Date(Date.now() - index * 60_000), // staggered timestamps
  };
}

export function makeChannel(
  userId: string,
  overrides: Partial<{ username: string }> = {},
) {
  return {
    id: crypto.randomUUID(),
    userId,
    platform: 'reddit' as const,
    username: overrides.username ?? 'testreddituser',
    oauthTokenEncrypted: 'fake-encrypted-token',
    refreshTokenEncrypted: 'fake-encrypted-refresh',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
  };
}

export function makeProduct(
  userId: string,
  overrides: Partial<{
    url: string;
    name: string;
    description: string;
    keywords: string[];
    valueProp: string;
  }> = {},
) {
  return {
    id: crypto.randomUUID(),
    userId,
    url: overrides.url ?? 'https://shipflare.dev',
    name: overrides.name ?? 'ShipFlare',
    description:
      overrides.description ??
      'AI marketing autopilot for indie developers',
    keywords: overrides.keywords ?? ['marketing', 'reddit', 'seo'],
    valueProp:
      overrides.valueProp ??
      'Automates Reddit marketing so indie devs can focus on building.',
    seoAuditJson: { score: 0, checks: [], recommendations: [] },
  };
}
