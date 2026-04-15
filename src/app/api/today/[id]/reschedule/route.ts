import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, xContentCalendar } from '@/lib/db/schema';
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

  let body: { scheduledFor?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.scheduledFor) {
    return NextResponse.json(
      { error: 'scheduledFor is required' },
      { status: 400 },
    );
  }

  const scheduledFor = new Date(body.scheduledFor);
  if (isNaN(scheduledFor.getTime())) {
    return NextResponse.json(
      { error: 'Invalid date format' },
      { status: 400 },
    );
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

  if (todo.source !== 'calendar') {
    return NextResponse.json(
      { error: 'Only calendar items can be rescheduled' },
      { status: 400 },
    );
  }

  // Update todo scheduledFor
  await db
    .update(todoItems)
    .set({ scheduledFor })
    .where(eq(todoItems.id, id));

  // Update corresponding calendar entry if draft is linked
  if (todo.draftId) {
    await db
      .update(xContentCalendar)
      .set({ scheduledAt: scheduledFor, updatedAt: new Date() })
      .where(eq(xContentCalendar.draftId, todo.draftId));
  }

  return NextResponse.json({ success: true });
}
