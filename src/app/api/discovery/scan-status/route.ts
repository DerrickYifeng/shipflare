import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { searchSourceQueue } from '@/lib/queue';

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const scanRunId = searchParams.get('scanRunId');
  if (!scanRunId) {
    return NextResponse.json({ error: 'scanRunId required' }, { status: 400 });
  }

  // Inspect BullMQ to report per-source state.
  const jobs = await searchSourceQueue.getJobs([
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
  ]);
  const forRun = jobs.filter(
    (j) => j && j.data.scanRunId === scanRunId && j.data.userId === userId,
  );

  const sources = await Promise.all(
    forRun.map(async (j) => {
      const state = await j.getState();
      return {
        id: `${j.data.platform}:${j.data.source}`,
        platform: j.data.platform,
        source: j.data.source,
        state:
          state === 'completed'
            ? 'searched'
            : state === 'failed'
              ? 'failed'
              : state === 'active'
                ? 'searching'
                : 'queued',
      };
    }),
  );

  return NextResponse.json({ scanRunId, sources });
}
