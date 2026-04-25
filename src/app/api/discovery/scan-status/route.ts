import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * GET /api/discovery/scan-status?scanRunId=...
 *
 * Legacy REST fallback for per-source scan status. Discovery v3 runs the
 * scout agent inline — there's no per-source BullMQ job to inspect — so
 * this endpoint returns an empty `sources` list. The UI should rely on
 * the SSE pipeline events stream for real-time status instead.
 *
 * Kept for back-compat with any UI that still polls this route; can be
 * deleted once callers are removed.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const scanRunId = searchParams.get('scanRunId');
  if (!scanRunId) {
    return NextResponse.json({ error: 'scanRunId required' }, { status: 400 });
  }

  return NextResponse.json({ scanRunId, sources: [] });
}
