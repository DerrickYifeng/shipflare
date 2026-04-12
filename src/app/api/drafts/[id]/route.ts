import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { replyBody } = await request.json();

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

  if (draft.status !== 'pending') {
    return NextResponse.json({ error: 'Can only edit pending drafts' }, { status: 400 });
  }

  await db
    .update(drafts)
    .set({ replyBody, updatedAt: new Date() })
    .where(eq(drafts.id, id));

  return NextResponse.json({ success: true });
}
