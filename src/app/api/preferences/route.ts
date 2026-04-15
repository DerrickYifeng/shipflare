import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { userPreferences } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const DEFAULT_PREFERENCES = {
  autoApproveEnabled: false,
  autoApproveThreshold: 0.85,
  autoApproveTypes: ['reply'] as string[],
  maxAutoApprovalsPerDay: 10,
  postingHoursUtc: [14, 17, 21] as number[],
  contentMixMetric: 40,
  contentMixEducational: 30,
  contentMixEngagement: 20,
  contentMixProduct: 10,
  notifyOnNewDraft: true,
  notifyOnAutoApprove: true,
  timezone: 'America/Los_Angeles',
};

const updateSchema = z.object({
  autoApproveEnabled: z.boolean().optional(),
  autoApproveThreshold: z.number().min(0.5).max(1.0).optional(),
  autoApproveTypes: z
    .array(z.enum(['reply', 'original_post']))
    .min(1)
    .optional(),
  maxAutoApprovalsPerDay: z.number().int().min(1).max(100).optional(),
  postingHoursUtc: z
    .array(z.number().int().min(0).max(23))
    .min(1)
    .max(6)
    .optional(),
  contentMixMetric: z.number().int().min(0).max(100).optional(),
  contentMixEducational: z.number().int().min(0).max(100).optional(),
  contentMixEngagement: z.number().int().min(0).max(100).optional(),
  contentMixProduct: z.number().int().min(0).max(100).optional(),
  notifyOnNewDraft: z.boolean().optional(),
  notifyOnAutoApprove: z.boolean().optional(),
  timezone: z.string().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);

  if (!prefs) {
    return NextResponse.json({ preferences: DEFAULT_PREFERENCES });
  }

  return NextResponse.json({
    preferences: {
      autoApproveEnabled: prefs.autoApproveEnabled,
      autoApproveThreshold: prefs.autoApproveThreshold,
      autoApproveTypes: prefs.autoApproveTypes,
      maxAutoApprovalsPerDay: prefs.maxAutoApprovalsPerDay,
      postingHoursUtc: prefs.postingHoursUtc,
      contentMixMetric: prefs.contentMixMetric,
      contentMixEducational: prefs.contentMixEducational,
      contentMixEngagement: prefs.contentMixEngagement,
      contentMixProduct: prefs.contentMixProduct,
      notifyOnNewDraft: prefs.notifyOnNewDraft,
      notifyOnAutoApprove: prefs.notifyOnAutoApprove,
      timezone: prefs.timezone,
    },
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;

  // Validate content mix sums to 100 if any mix fields provided
  const mixFields = [
    data.contentMixMetric,
    data.contentMixEducational,
    data.contentMixEngagement,
    data.contentMixProduct,
  ];
  if (mixFields.some((f) => f !== undefined)) {
    // Load existing to fill in missing values
    const [existing] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id))
      .limit(1);

    const metric = data.contentMixMetric ?? existing?.contentMixMetric ?? 40;
    const educational = data.contentMixEducational ?? existing?.contentMixEducational ?? 30;
    const engagement = data.contentMixEngagement ?? existing?.contentMixEngagement ?? 20;
    const product = data.contentMixProduct ?? existing?.contentMixProduct ?? 10;

    if (metric + educational + engagement + product !== 100) {
      return NextResponse.json(
        { error: 'Content mix ratios must sum to 100' },
        { status: 400 },
      );
    }
  }

  // Upsert preferences
  const [result] = await db
    .insert(userPreferences)
    .values({
      userId: session.user.id,
      ...data,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        ...data,
        updatedAt: new Date(),
      },
    })
    .returning();

  return NextResponse.json({
    preferences: {
      autoApproveEnabled: result.autoApproveEnabled,
      autoApproveThreshold: result.autoApproveThreshold,
      autoApproveTypes: result.autoApproveTypes,
      maxAutoApprovalsPerDay: result.maxAutoApprovalsPerDay,
      postingHoursUtc: result.postingHoursUtc,
      contentMixMetric: result.contentMixMetric,
      contentMixEducational: result.contentMixEducational,
      contentMixEngagement: result.contentMixEngagement,
      contentMixProduct: result.contentMixProduct,
      notifyOnNewDraft: result.notifyOnNewDraft,
      notifyOnAutoApprove: result.notifyOnAutoApprove,
      timezone: result.timezone,
    },
  });
}
