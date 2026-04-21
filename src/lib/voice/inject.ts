/**
 * Build the <voice_profile> XML block injected into writer agent prompts
 * (x-writer, reddit-writer) and the draft-single-reply skill. Pure function —
 * takes a profile row, returns a string (or null when profile is absent).
 */

import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export interface VoiceProfileRow {
  register: string;
  pronouns: string;
  capitalization: string;
  emojiPolicy: string;
  signatureEmoji: string | null;
  punctuationSignatures: string[];
  humorRegister: string[];
  bannedWords: string[];
  bannedPhrases: string[];
  worldviewTags: string[];
  openerPreferences: string[];
  closerPolicy: string;
  voiceStrength: string;
  extractedStyleCardMd: string | null;
  sampleTweets: Array<{ id: string; text: string; engagement: number }>;
}

export interface BuildVoiceBlockOptions {
  seed?: number;
  sampleCount?: number;
}

function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildVoiceBlock(
  profile: VoiceProfileRow | null | undefined,
  options: BuildVoiceBlockOptions = {},
): string | null {
  if (!profile) return null;

  const { seed = Date.now(), sampleCount = 5 } = options;
  const strength = profile.voiceStrength;
  const includeCard = strength !== 'loose';
  const includeBannedPhrases = strength === 'strict';

  const parts: string[] = ['<voice_profile>'];

  parts.push('<register>' + profile.register + '</register>');
  parts.push('<pronouns>' + profile.pronouns + '</pronouns>');
  parts.push('<capitalization>' + profile.capitalization + '</capitalization>');
  parts.push(
    '<emoji_policy>' +
      profile.emojiPolicy +
      (profile.signatureEmoji ? ` (signature: ${profile.signatureEmoji})` : '') +
      '</emoji_policy>',
  );
  if (profile.punctuationSignatures.length > 0) {
    parts.push(
      '<punctuation>' + profile.punctuationSignatures.join(', ') + '</punctuation>',
    );
  }
  if (profile.humorRegister.length > 0) {
    parts.push('<humor>' + profile.humorRegister.join(', ') + '</humor>');
  }
  if (profile.worldviewTags.length > 0) {
    parts.push('<worldview>' + profile.worldviewTags.join(', ') + '</worldview>');
  }
  if (profile.openerPreferences.length > 0) {
    parts.push('<openers>' + profile.openerPreferences.join(' | ') + '</openers>');
  }
  parts.push('<closer>' + profile.closerPolicy + '</closer>');

  if (profile.bannedWords.length > 0) {
    parts.push('<banned_words>' + profile.bannedWords.join(', ') + '</banned_words>');
  }
  if (includeBannedPhrases && profile.bannedPhrases.length > 0) {
    parts.push(
      '<banned_phrases>' + profile.bannedPhrases.join(' | ') + '</banned_phrases>',
    );
  }

  if (includeCard && profile.extractedStyleCardMd) {
    parts.push('<style_card>');
    parts.push(profile.extractedStyleCardMd.trim());
    parts.push('</style_card>');
  }

  const pool = profile.sampleTweets;
  if (pool.length > 0) {
    const shuffled = seededShuffle(pool, seed);
    const picks = shuffled.slice(0, Math.min(sampleCount, shuffled.length));
    parts.push('<examples>');
    for (const pick of picks) {
      parts.push('<example>' + pick.text.replace(/\n/g, ' ') + '</example>');
    }
    parts.push('</examples>');
  }

  parts.push(
    '<instruction>Write in the voice described above. Do not copy example tweets verbatim — they show rhythm and vocabulary, not content. Honor banned_words as hard constraints.</instruction>',
  );
  parts.push('</voice_profile>');

  return parts.join('\n');
}

/**
 * Fetch voice profile for (userId, channel) and build the injection block.
 * Returns null when no profile exists — callers proceed with defaults.
 */
export async function loadVoiceBlockForUser(
  userId: string,
  channel: string,
  options: BuildVoiceBlockOptions = {},
): Promise<string | null> {
  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.userId, userId), eq(voiceProfiles.channel, channel)))
    .limit(1);

  if (!profile) return null;
  return buildVoiceBlock(profile as VoiceProfileRow, options);
}
