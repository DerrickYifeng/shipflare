import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enqueueVoiceExtract } from '@/lib/queue/voice-extract';
import { z } from 'zod';

const bodySchema = z.object({
  channel: z.enum(['x']).default('x'),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine; defaults will fill in.
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { channel } = parsed.data;

  await enqueueVoiceExtract({
    schemaVersion: 1,
    userId: session.user.id,
    channel,
    triggerReason: 'manual',
  });

  return NextResponse.json({ ok: true });
}
