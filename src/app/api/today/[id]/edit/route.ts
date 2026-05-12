import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, planItems } from '@/lib/db/schema';
import {
  findOwnedPlanItem,
  paramsSchema,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:edit');

/**
 * PATCH /api/today/:id/edit
 *
 * Inline-edit a draft's body. The Today feed merges two data sources;
 * `:id` may resolve to either, so the handler tries plan_items first
 * (where original-post drafts live in `output.draft_body`) and falls
 * back to the drafts table (reply drafts in `reply_body`).
 *
 * Edits are only permitted on pre-terminal states:
 *   - plan_items: state ∈ {drafted, ready_for_review}
 *   - drafts:     status = 'pending'
 *
 * Approved / handed_off / posted rows are immutable — the user has
 * already committed; reverting requires the dispatcher's undo path,
 * not a bare body PATCH.
 *
 * Status codes:
 *   200  success
 *   400  invalid_id | invalid_body
 *   401  unauthorized
 *   404  not_found
 *   409  not_editable (already approved / handed off / posted / etc.)
 */

const MAX_BODY = 50_000; // cap as guard against pathological payloads;
                         // platform-specific caps are enforced at post time.

/**
 * Reddit subreddit name regex: 3-21 chars, letters / digits / underscore.
 * Mirrors the server's own subreddit-name rules in
 * `/api/reddit-channels` so the subreddit picker on the post card and
 * this endpoint agree on what's valid.
 */
const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{3,21}$/;

const paramsPatchSchema = z
  .object({
    subreddit: z.string().regex(SUBREDDIT_REGEX).optional(),
  })
  .strict()
  // `{ params: {} }` would otherwise pass the outer refine and trigger
  // a no-op UPDATE (touches updatedAt for nothing). Require at least
  // one known key so writes are always meaningful.
  .refine(
    (p) => Object.keys(p).length > 0,
    'params must include at least one key',
  );

const editPayloadSchema = z
  .object({
    body: z.string().min(1).max(MAX_BODY).optional(),
    params: paramsPatchSchema.optional(),
  })
  .refine(
    (d) => typeof d.body === 'string' || d.params !== undefined,
    'at least one of body or params must be set',
  );

// State sets used for the edit gate. Listed inline so they read at the
// call site without a hop into shared state-machine config.
const EDITABLE_PLAN_STATES = new Set(['drafted', 'ready_for_review']);
const EDITABLE_DRAFT_STATUSES = new Set(['pending']);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { id: rawId } = await params;
  const idParse = paramsSchema.safeParse({ id: rawId });
  if (!idParse.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  const id = idParse.data.id;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  const bodyParse = editPayloadSchema.safeParse(payload);
  if (!bodyParse.success) {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  // Normalize the optional fields up-front so the rest of the handler
  // doesn't have to re-check shape. `bodyText` is only used when the
  // patch includes a body; empty/whitespace-only bodies still 400 here.
  const rawBody = bodyParse.data.body;
  let bodyText: string | null = null;
  if (typeof rawBody === 'string') {
    const trimmed = rawBody.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: 'invalid_body' },
        { status: 400, headers: { 'x-trace-id': traceId } },
      );
    }
    bodyText = trimmed;
  }
  const paramsPatch = bodyParse.data.params;

  // Plan-item path first — original posts (content_post) live here, body
  // in output.draft_body. The findOwned* helper scopes to this user, so a
  // missing row could mean "wrong user" or "doesn't exist"; both should
  // fall through to the drafts lookup before returning 404 (info leakage).
  const planRow = await findOwnedPlanItem(id, userId);
  if (planRow) {
    if (!EDITABLE_PLAN_STATES.has(planRow.state)) {
      return NextResponse.json(
        { error: 'not_editable', state: planRow.state },
        { status: 409, headers: { 'x-trace-id': traceId } },
      );
    }
    // Body update: jsonb_set on a missing key inserts it; coalesce
    // defends against rows where output is NULL (legacy / partially-
    // written rows).
    if (bodyText !== null) {
      await db
        .update(planItems)
        .set({
          output: sql`jsonb_set(coalesce(${planItems.output}, '{}'::jsonb), '{draft_body}', to_jsonb(${bodyText}::text))`,
          updatedAt: sql`now()`,
        })
        .where(eq(planItems.id, planRow.id));
      log.info(`plan_item ${planRow.id} body edited (${bodyText.length} chars)`);
    }
    // Params update: merge onto the existing params jsonb so we don't
    // clobber sibling keys (e.g. `targetCount`, `templateId`). The
    // round-trip through findOwnedPlanItem already validated ownership;
    // we re-read params from there rather than running another query.
    if (paramsPatch !== undefined) {
      const nextParams: Record<string, unknown> = {
        ...(planRow.params ?? {}),
        ...paramsPatch,
      };
      await db
        .update(planItems)
        .set({ params: nextParams, updatedAt: sql`now()` })
        .where(eq(planItems.id, planRow.id));
      log.info(
        `plan_item ${planRow.id} params edited (keys: ${Object.keys(paramsPatch).join(',')})`,
      );
    }
    return NextResponse.json(
      { success: true, source: 'plan_item' },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  // Drafts path — reply cards. Scope by userId so we don't leak ownership.
  const draftRow = await db
    .select({
      id: drafts.id,
      userId: drafts.userId,
      status: drafts.status,
    })
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
    .limit(1);

  const draft = draftRow[0];
  if (!draft) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  if (!EDITABLE_DRAFT_STATUSES.has(draft.status)) {
    return NextResponse.json(
      { error: 'not_editable', status: draft.status },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }
  // The `drafts` table has no `params` column — params patches only
  // apply to plan_items. Reject up-front rather than silently dropping
  // the patch on the floor.
  if (paramsPatch !== undefined) {
    return NextResponse.json(
      { error: 'params_not_supported_on_draft' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  // `bodyText` is guaranteed non-null here: the editPayloadSchema refine
  // requires at least one of body/params, paramsPatch is undefined on
  // this branch, so bodyText must be set.
  if (bodyText === null) {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  await db
    .update(drafts)
    .set({ replyBody: bodyText, updatedAt: new Date() })
    .where(eq(drafts.id, draft.id));
  log.info(`draft ${draft.id} replyBody edited (${bodyText.length} chars)`);
  return NextResponse.json(
    { success: true, source: 'draft' },
    { headers: { 'x-trace-id': traceId } },
  );
}
