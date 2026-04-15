import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, drafts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

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

  // Skip linked draft too
  if (todo.draftId) {
    await db
      .update(drafts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(drafts.id, todo.draftId));
  }

  await db
    .update(todoItems)
    .set({ status: 'skipped', actedAt: new Date() })
    .where(eq(todoItems.id, id));

  return NextResponse.json({ success: true });
}
