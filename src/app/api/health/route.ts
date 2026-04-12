import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { healthScores } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [latest] = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.userId, session.user.id))
    .orderBy(desc(healthScores.calculatedAt))
    .limit(1);

  return NextResponse.json({
    healthScore: latest
      ? {
          score: latest.score,
          s1Pipeline: latest.s1Pipeline,
          s2Quality: latest.s2Quality,
          s3Engagement: latest.s3Engagement,
          s4Consistency: latest.s4Consistency,
          s5Safety: latest.s5Safety,
          createdAt: latest.calculatedAt,
        }
      : null,
  });
}
