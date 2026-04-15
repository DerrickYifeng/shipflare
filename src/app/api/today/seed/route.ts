import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { seedTodosForUser } from '@/lib/today/seed';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:today:seed');

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const count = await seedTodosForUser(session.user.id);
    log.info(`Manual seed for user ${session.user.id}: ${count} items created`);
    return NextResponse.json({ seeded: true, count });
  } catch (error: unknown) {
    log.error(
      `Seed failed for user ${session.user.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return NextResponse.json(
      { error: 'Failed to seed todos' },
      { status: 500 },
    );
  }
}
