import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';
import { PLATFORMS } from '@/lib/platform-config';

const log = createLogger('api:reddit:connect');

const bodySchema = z.object({
  handle: z
    .string()
    .min(1)
    .max(40)
    .transform((s) => s.replace(/^\/?u\//i, '').trim())
    .refine((s) => /^[A-Za-z0-9_-]{3,20}$/.test(s), {
      message:
        'Reddit handles must be 3-20 chars: letters, digits, underscores, dashes only.',
    }),
});

export async function POST(request: Request): Promise<Response> {
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

  await db
    .insert(channels)
    .values({
      userId: session.user.id,
      platform: PLATFORMS.reddit.id,
      username: parsed.data.handle,
      oauthTokenEncrypted: null,
      refreshTokenEncrypted: null,
    })
    .onConflictDoUpdate({
      target: [channels.userId, channels.platform],
      set: { username: parsed.data.handle, updatedAt: new Date() },
    });

  log.info(
    `reddit channel connected for user ${session.user.id}: u/${parsed.data.handle}`,
  );
  return NextResponse.json({ success: true });
}
