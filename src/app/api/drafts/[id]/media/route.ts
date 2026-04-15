import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:drafts:media');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_MEDIA_PER_DRAFT = 4;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: draftId } = await params;

  // Verify draft ownership
  const [draft] = await db
    .select({ id: drafts.id, media: drafts.media })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  const currentMedia = (draft.media ?? []) as Array<{ url: string; type: 'image' | 'gif' | 'video'; alt?: string }>;
  if (currentMedia.length >= MAX_MEDIA_PER_DRAFT) {
    return NextResponse.json(
      { error: `Maximum ${MAX_MEDIA_PER_DRAFT} media items per draft` },
      { status: 400 },
    );
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'File type not allowed. Use JPEG, PNG, GIF, or WebP.' },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: 'File too large. Maximum 5MB.' },
      { status: 400 },
    );
  }

  // Store in public/uploads/drafts/{draftId}/
  const uploadDir = join(process.cwd(), 'public', 'uploads', 'drafts', draftId);
  await mkdir(uploadDir, { recursive: true });

  const ext = file.name.split('.').pop() ?? 'bin';
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filePath = join(uploadDir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  const url = `/uploads/drafts/${draftId}/${filename}`;
  const mediaType: 'image' | 'gif' = file.type === 'image/gif' ? 'gif' : 'image';

  const updatedMedia: Array<{ url: string; type: 'image' | 'gif' | 'video'; alt?: string }> = [
    ...currentMedia,
    { url, type: mediaType, alt: (formData.get('alt') as string) || undefined },
  ];

  await db
    .update(drafts)
    .set({ media: updatedMedia, updatedAt: new Date() })
    .where(eq(drafts.id, draftId));

  log.info(`Media uploaded for draft ${draftId}: ${url}`);

  return NextResponse.json({ url, media: updatedMedia });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: draftId } = await params;
  const { url } = await request.json();

  const [draft] = await db
    .select({ id: drafts.id, media: drafts.media })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  const currentMedia = (draft.media ?? []) as Array<{ url: string; type: 'image' | 'gif' | 'video'; alt?: string }>;
  const updatedMedia = currentMedia.filter((m) => m.url !== url);

  await db
    .update(drafts)
    .set({ media: updatedMedia, updatedAt: new Date() })
    .where(eq(drafts.id, draftId));

  return NextResponse.json({ media: updatedMedia });
}
