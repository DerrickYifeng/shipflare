import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, drafts } from '@/lib/db/schema';
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
  const userId = session.user.id;

  let body: { body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.body || typeof body.body !== 'string') {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  const [todo] = await db
    .select()
    .from(todoItems)
    .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)))
    .limit(1);

  if (!todo) {
    return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
  }

  if (todo.status !== 'pending') {
    return NextResponse.json(
      { error: 'Todo already processed' },
      { status: 400 },
    );
  }

  if (!todo.draftId) {
    return NextResponse.json(
      { error: 'No draft linked to this todo' },
      { status: 400 },
    );
  }

  // Update the linked draft body
  await db
    .update(drafts)
    .set({ replyBody: body.body, updatedAt: new Date() })
    .where(eq(drafts.id, todo.draftId));

  return NextResponse.json({ success: true });
}
