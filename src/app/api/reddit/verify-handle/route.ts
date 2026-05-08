import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { RedditClient } from '@/lib/reddit-client';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:reddit:verify-handle');

const bodySchema = z.object({
  handle: z
    .string()
    .min(1)
    .max(40)
    .transform((s) => s.replace(/^\/?u\//i, '').trim())
    .refine((s) => /^[A-Za-z0-9_-]{3,20}$/.test(s), {
      message: 'Reddit handles must be 3-20 chars: letters, digits, _ or -.',
    }),
});

export async function POST(request: Request): Promise<Response> {
  const { log } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_handle', detail: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const profile = await RedditClient.appOnly().getUserAboutPublic(
      parsed.data.handle,
    );
    if (!profile) {
      return NextResponse.json({ exists: false });
    }
    return NextResponse.json({ exists: true, karma: profile.total_karma });
  } catch (err) {
    log.warn(
      `verify-handle transient error for u/${parsed.data.handle}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NextResponse.json({ exists: null, error: 'reddit_unavailable' });
  }
}
