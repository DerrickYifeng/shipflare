import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const DEFAULT_PROFILE_FOR_CHANNEL = (userId: string, channel: string) => ({
  userId,
  channel,
  register: 'builder_log' as const,
  pronouns: 'i' as const,
  capitalization: 'sentence' as const,
  emojiPolicy: 'sparing' as const,
  signatureEmoji: null,
  punctuationSignatures: [] as string[],
  humorRegister: [] as string[],
  bannedWords: [] as string[],
  bannedPhrases: [] as string[],
  worldviewTags: [] as string[],
  openerPreferences: [] as string[],
  closerPolicy: 'silent_stop' as const,
  voiceStrength: 'moderate' as const,
});

const REGISTER_VALUES = ['builder_log', 'operator_essay', 'shitposter', 'thought_leader', 'researcher'] as const;
const PRONOUN_VALUES = ['i', 'we', 'you_direct'] as const;
const CAPITALIZATION_VALUES = ['sentence', 'lowercase', 'title'] as const;
const EMOJI_POLICY_VALUES = ['none', 'sparing', 'signature'] as const;
const PUNCTUATION_VALUES = ['em_dash', 'ellipsis', 'parenthetical_aside', 'one_line_per_sentence'] as const;
const HUMOR_VALUES = ['self_deprecating', 'dry', 'absurdist', 'meme', 'none'] as const;
const WORLDVIEW_VALUES = ['pro_craft', 'anti_hype', 'pro_hustle', 'pro_calm', 'contrarian', 'pro_open_source'] as const;
const CLOSER_POLICY_VALUES = ['question', 'cta', 'payoff', 'silent_stop'] as const;
const VOICE_STRENGTH_VALUES = ['loose', 'moderate', 'strict'] as const;

const updateSchema = z.object({
  channel: z.string().default('x'),
  register: z.enum(REGISTER_VALUES).optional(),
  pronouns: z.enum(PRONOUN_VALUES).optional(),
  capitalization: z.enum(CAPITALIZATION_VALUES).optional(),
  emojiPolicy: z.enum(EMOJI_POLICY_VALUES).optional(),
  signatureEmoji: z.string().max(8).nullable().optional(),
  punctuationSignatures: z.array(z.enum(PUNCTUATION_VALUES)).optional(),
  humorRegister: z.array(z.enum(HUMOR_VALUES)).optional(),
  bannedWords: z.array(z.string().min(1).max(40)).max(50).optional(),
  bannedPhrases: z.array(z.string().min(1).max(120)).max(20).optional(),
  worldviewTags: z.array(z.enum(WORLDVIEW_VALUES)).optional(),
  openerPreferences: z.array(z.string().max(40)).max(10).optional(),
  closerPolicy: z.enum(CLOSER_POLICY_VALUES).optional(),
  voiceStrength: z.enum(VOICE_STRENGTH_VALUES).optional(),
  extractedStyleCardMd: z.string().max(4000).nullable().optional(),
  markEdited: z.boolean().optional(),
});

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const channel = url.searchParams.get('channel') ?? 'x';

  const [existing] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.userId, session.user.id), eq(voiceProfiles.channel, channel)))
    .limit(1);

  if (existing) {
    return NextResponse.json({ profile: existing });
  }

  // Lazy init: create a default row so the UI has something to edit.
  const defaults = DEFAULT_PROFILE_FOR_CHANNEL(session.user.id, channel);
  const [created] = await db
    .insert(voiceProfiles)
    .values(defaults)
    .returning();

  return NextResponse.json({ profile: created });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { channel, markEdited, ...rest } = parsed.data;

  // Build the "set" payload. Omit undefined fields so partial updates work.
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) setValues[k] = v;
  }
  if (markEdited === true) setValues.styleCardEdited = true;

  await db
    .insert(voiceProfiles)
    .values({
      ...DEFAULT_PROFILE_FOR_CHANNEL(session.user.id, channel),
      ...setValues,
      styleCardEdited: markEdited === true,
    })
    .onConflictDoUpdate({
      target: [voiceProfiles.userId, voiceProfiles.channel],
      set: setValues,
    });

  const [updated] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.userId, session.user.id), eq(voiceProfiles.channel, channel)))
    .limit(1);

  return NextResponse.json({ profile: updated, ok: true });
}
