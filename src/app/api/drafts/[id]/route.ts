import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:drafts');

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  log.info(`PATCH /api/drafts/${id}`);

  let body: { replyBody?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { replyBody } = body;

  if (!replyBody || typeof replyBody !== 'string') {
    return NextResponse.json({ error: 'replyBody is required' }, { status: 400 });
  }

  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  if (draft.status !== 'pending' && draft.status !== 'needs_revision') {
    return NextResponse.json(
      { error: 'Can only edit pending or needs_revision drafts' },
      { status: 400 },
    );
  }

  await db
    .update(drafts)
    .set({
      replyBody,
      status: 'pending', // Reset to pending after edit so it goes through review again
      reviewVerdict: null,
      reviewScore: null,
      reviewJson: null,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, id));

  return NextResponse.json({ success: true });
}
