import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getGitHubToken, listUserRepos } from '@/lib/github';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:github-repos');

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await getGitHubToken(session.user.id);
  if (!token) {
    return NextResponse.json(
      { error: 'No GitHub account linked' },
      { status: 404 },
    );
  }

  try {
    log.info('GET /api/onboarding/github-repos');
    const repos = await listUserRepos(token);
    return NextResponse.json({ repos });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch repos';
    log.error(`github-repos failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
