import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  deleteDraft,
  getDraft,
  putDraft,
  type OnboardingDraft,
} from '@/lib/onboarding-draft';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:onboarding:draft');

export const dynamic = 'force-dynamic';

/**
 * GET /api/onboarding/draft
 *
 * Returns the user's current onboarding draft or `null` when nothing
 * is stashed yet. Never 404s for an empty draft — frontend treats null
 * as "blank slate" without special-casing.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const draft = await getDraft(session.user.id);
  return NextResponse.json(
    { draft },
    { headers: { 'x-trace-id': traceId } },
  );
}

/**
 * PUT /api/onboarding/draft
 *
 * Merge-upserts the draft. Body is `Partial<OnboardingDraft>`; unspecified
 * fields are preserved. Rolls the 1h TTL forward on every write.
 *
 * Shallow merge — nested fields (e.g. `previewPath`) are replaced
 * wholesale. Frontend sends the complete nested value when it wants to
 * update one.
 */
export async function PUT(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let patch: Partial<OnboardingDraft>;
  try {
    patch = (await request.json()) as Partial<OnboardingDraft>;
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return NextResponse.json(
      { error: 'invalid_request', detail: 'body must be a JSON object' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  await putDraft(session.user.id, patch);
  const next = await getDraft(session.user.id);
  log.debug(`PUT draft user=${session.user.id} keys=${Object.keys(patch).join(',')}`);

  return NextResponse.json(
    { draft: next },
    { headers: { 'x-trace-id': traceId } },
  );
}

/**
 * DELETE /api/onboarding/draft
 *
 * Clears the draft. Idempotent; returns 200 even when no draft exists.
 * Called from /api/onboarding/commit on success, but also usable from
 * the frontend "start over" button.
 */
export async function DELETE(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  await deleteDraft(session.user.id);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
