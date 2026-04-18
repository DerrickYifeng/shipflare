import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn();
const runSkillMock = vi.fn();

// Mock xClient exposes getMe + getUserTweets (the real XClient methods).
const xClientMock = {
  getMe: vi.fn().mockResolvedValue({ id: 'xuser-123', username: 'testuser' }),
  getUserTweets: vi.fn(),
};

const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => selectQueue.shift() ?? [] }),
      }),
    }),
    update: () => ({
      set: (v: unknown) => {
        updateMock(v);
        return { where: () => ({}) };
      },
    }),
  },
}));
vi.mock('@/lib/platform-deps', () => ({
  createPlatformDeps: async () => ({ xClient: xClientMock }),
}));
vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({
  loadSkill: () => ({ name: 'voice-extractor' }),
}));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  updateMock.mockReset();
  xClientMock.getMe.mockResolvedValue({ id: 'xuser-123', username: 'testuser' });
});

describe('processVoiceExtract', () => {
  it('skips extraction when styleCardEdited is true (respects user edits)', async () => {
    pushSelect([
      {
        id: 'vp-1',
        userId: 'u-1',
        channel: 'x',
        register: 'builder_log',
        pronouns: 'i',
        capitalization: 'sentence',
        emojiPolicy: 'sparing',
        signatureEmoji: null,
        punctuationSignatures: [],
        humorRegister: [],
        bannedWords: [],
        bannedPhrases: [],
        worldviewTags: [],
        openerPreferences: [],
        closerPolicy: 'silent_stop',
        voiceStrength: 'moderate',
        extractedStyleCardMd: 'user wrote this',
        sampleTweets: [],
        extractionVersion: 1,
        styleCardEdited: true,
      },
    ]);

    xClientMock.getUserTweets.mockResolvedValueOnce({
      tweets: Array.from({ length: 20 }, (_, i) => ({
        id: `t${i}`,
        text: `tweet ${i}`,
        metrics: { bookmarks: i, likes: i, retweets: 0, quotes: 0, replies: 0, impressions: 0 },
      })),
      newestId: 't19',
    });

    runSkillMock.mockResolvedValueOnce({
      results: [
        {
          styleCardMd: 'extractor tried to write this',
          detectedBannedWords: [],
          topBigrams: [],
          avgSentenceLength: 10,
          lengthHistogram: {},
          openerHistogram: {},
          confidence: 0.8,
        },
      ],
      errors: [],
      usage: { costUsd: 0 },
    });

    const { processVoiceExtract } = await import('../voice-extract');
    await processVoiceExtract({
      id: 'j',
      data: {
        schemaVersion: 1,
        userId: 'u-1',
        channel: 'x',
        triggerReason: 'monthly_cron',
      },
    } as never);

    const setCall = updateMock.mock.calls[0]?.[0];
    expect(setCall).toBeDefined();
    // User-edited card must not be overwritten.
    expect(setCall).not.toHaveProperty('extractedStyleCardMd');
    // Samples + histograms still refreshed.
    expect(setCall).toHaveProperty('sampleTweets');
    expect(setCall).toHaveProperty('avgSentenceLength');
  });

  it('runs extractor and writes styleCardMd when user has not edited', async () => {
    pushSelect([
      {
        id: 'vp-2',
        userId: 'u-2',
        channel: 'x',
        register: 'builder_log',
        pronouns: 'i',
        capitalization: 'sentence',
        emojiPolicy: 'sparing',
        signatureEmoji: null,
        punctuationSignatures: [],
        humorRegister: [],
        bannedWords: [],
        bannedPhrases: [],
        worldviewTags: [],
        openerPreferences: [],
        closerPolicy: 'silent_stop',
        voiceStrength: 'moderate',
        extractedStyleCardMd: null,
        sampleTweets: [],
        extractionVersion: 0,
        styleCardEdited: false,
      },
    ]);

    xClientMock.getUserTweets.mockResolvedValueOnce({
      tweets: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        text: `sample tweet ${i}`,
        metrics: { bookmarks: i, likes: i, retweets: 0, quotes: 0, replies: 0, impressions: 0 },
      })),
      newestId: 't9',
    });

    runSkillMock.mockResolvedValueOnce({
      results: [
        {
          styleCardMd: '# extracted card\nshort sentences.',
          detectedBannedWords: ['leverage'],
          topBigrams: [['shipped', 'today']],
          avgSentenceLength: 8.2,
          lengthHistogram: { '50-100': 7, '100-150': 3 },
          openerHistogram: { just_shipped: 4 },
          confidence: 0.8,
        },
      ],
      errors: [],
      usage: { costUsd: 0.001 },
    });

    const { processVoiceExtract } = await import('../voice-extract');
    await processVoiceExtract({
      id: 'j',
      data: {
        schemaVersion: 1,
        userId: 'u-2',
        channel: 'x',
        triggerReason: 'onboarding',
      },
    } as never);

    const setCall = updateMock.mock.calls[0]?.[0];
    expect(setCall.extractedStyleCardMd).toContain('extracted card');
    expect(setCall.avgSentenceLength).toBe(8.2);
    expect(setCall.extractionVersion).toBe(1);
    // Banned-word merge: extractor detected "leverage", user's list was empty → final has "leverage".
    expect(setCall.bannedWords).toContain('leverage');
  });
});
