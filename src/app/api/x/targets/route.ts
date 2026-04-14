import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xTargetAccounts, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { XClient } from '@/lib/x-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x:targets');

/**
 * GET /api/x/targets
 * List the user's monitored X target accounts.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const targets = await db
    .select()
    .from(xTargetAccounts)
    .where(eq(xTargetAccounts.userId, session.user.id))
    .orderBy(xTargetAccounts.priority);

  return NextResponse.json({ targets });
}

/**
 * POST /api/x/targets
 * Add a new target account. Validates username via X API lookup.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    username?: string;
    category?: string;
    priority?: number;
    notes?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { username, category, priority, notes } = body;

  if (!username || typeof username !== 'string') {
    return NextResponse.json({ error: 'username is required' }, { status: 400 });
  }

  const cleanUsername = username.replace(/^@/, '').trim();
  if (!cleanUsername) {
    return NextResponse.json({ error: 'Invalid username' }, { status: 400 });
  }

  // Check for duplicate
  const [existing] = await db
    .select()
    .from(xTargetAccounts)
    .where(
      and(
        eq(xTargetAccounts.userId, session.user.id),
        eq(xTargetAccounts.username, cleanUsername),
      ),
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: `@${cleanUsername} is already in your target list` },
      { status: 400 },
    );
  }

  // Load X channel for API validation
  const [xChannel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, 'x'),
      ),
    )
    .limit(1);

  let xUserId: string | null = null;
  let displayName: string | null = null;
  let followerCount: number | null = null;

  if (xChannel) {
    try {
      const xClient = XClient.fromChannel(xChannel);
      const user = await xClient.lookupUser(cleanUsername);
      xUserId = user.id;
      displayName = user.name;
      followerCount = user.followersCount ?? null;
    } catch (err) {
      log.warn(`Failed to look up @${cleanUsername}: ${err}`);
      // Continue without validation — user can still add the target
    }
  }

  const [target] = await db
    .insert(xTargetAccounts)
    .values({
      userId: session.user.id,
      username: cleanUsername,
      displayName,
      xUserId,
      followerCount,
      category: category ?? null,
      priority: priority ?? 1,
      notes: notes ?? null,
    })
    .returning();

  log.info(`Added target @${cleanUsername} for user ${session.user.id}`);
  return NextResponse.json({ target });
}

/**
 * DELETE /api/x/targets
 * Soft-delete a target account (set isActive=false).
 */
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { targetId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.targetId) {
    return NextResponse.json({ error: 'targetId is required' }, { status: 400 });
  }

  const [target] = await db
    .select()
    .from(xTargetAccounts)
    .where(
      and(
        eq(xTargetAccounts.id, body.targetId),
        eq(xTargetAccounts.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  }

  await db
    .update(xTargetAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(xTargetAccounts.id, body.targetId));

  log.info(`Deactivated target @${target.username} for user ${session.user.id}`);
  return NextResponse.json({ success: true });
}
