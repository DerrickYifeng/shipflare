import {
  pgTable, text, timestamp, integer, jsonb, boolean, real, unique, index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user voice profile, per channel. Hybrid schema:
 *  - structured fields edited by the user in onboarding / settings
 *  - LLM-extracted style card + top-engagement sample tweets
 *
 * Generation time injects both layers via `buildVoiceBlock()`.
 *
 * No tokens or PII live here. `sampleTweets` is the raw tweet text only —
 * publicly posted content the user already owns on X.
 */
export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),

    // Structured (user-editable)
    register: text('register').notNull().default('builder_log'),
    pronouns: text('pronouns').notNull().default('i'),
    capitalization: text('capitalization').notNull().default('sentence'),
    emojiPolicy: text('emoji_policy').notNull().default('sparing'),
    signatureEmoji: text('signature_emoji'),
    punctuationSignatures: jsonb('punctuation_signatures')
      .notNull()
      .$type<string[]>()
      .default([]),
    humorRegister: jsonb('humor_register')
      .notNull()
      .$type<string[]>()
      .default([]),
    bannedWords: jsonb('banned_words').notNull().$type<string[]>().default([]),
    bannedPhrases: jsonb('banned_phrases').notNull().$type<string[]>().default([]),
    worldviewTags: jsonb('worldview_tags').notNull().$type<string[]>().default([]),
    openerPreferences: jsonb('opener_preferences')
      .notNull()
      .$type<string[]>()
      .default([]),
    closerPolicy: text('closer_policy').notNull().default('silent_stop'),
    voiceStrength: text('voice_strength').notNull().default('moderate'),

    // Auto-extracted
    extractedStyleCardMd: text('extracted_style_card_md'),
    sampleTweets: jsonb('sample_tweets')
      .notNull()
      .$type<Array<{ id: string; text: string; engagement: number }>>()
      .default([]),
    avgSentenceLength: real('avg_sentence_length'),
    openerHistogram: jsonb('opener_histogram')
      .$type<Record<string, number>>()
      .default({}),
    lengthHistogram: jsonb('length_histogram')
      .$type<Record<string, number>>()
      .default({}),
    extractionVersion: integer('extraction_version').notNull().default(0),
    lastExtractedAt: timestamp('last_extracted_at', { mode: 'date' }),

    styleCardEdited: boolean('style_card_edited').notNull().default(false),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    unique('voice_profiles_user_channel').on(t.userId, t.channel),
    index('voice_profiles_user_idx').on(t.userId),
  ],
);
