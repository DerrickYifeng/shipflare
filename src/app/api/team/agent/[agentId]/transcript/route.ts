// UI-B Task 9: per-teammate transcript endpoint.
//
// Returns the chronological message history for a single `agent_runs`
// row, suitable for hydrating the right-side TeammateTranscriptDrawer.
// Source of truth is `loadAgentRunHistory` (Phase D's helper) which
// rebuilds Anthropic.Messages.MessageParam[] from `team_messages` rows
// where the agent is the sender OR the recipient.
//
// Auth: the requesting user must own the team that contains this
// `agent_runs` row. We verify via the chain
// `agent_runs.team_id → teams.user_id` and return 404 (not 403) on
// cross-user requests so the endpoint doesn't leak agent existence to
// users that don't own it.
//
// Response shape:
//   { messages: Array<{ role: 'user' | 'assistant', content: string }> }

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentRuns, teams } from '@/lib/db/schema';
import { loadAgentRunHistory } from '@/workers/processors/lib/agent-run-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  /**
   * Anthropic.Messages.MessageParam allows `string | ContentBlockParam[]`
   * for content. Most rebuilt history entries are plain strings; on the
   * wire we serialize the structured form as a JSON string fallback so
   * the client can still render *something* without a tool-use renderer.
   * The drawer treats this field as opaque text.
   */
  content: string;
}

export interface TranscriptResponse {
  messages: TranscriptMessage[];
}

/**
 * GET /api/team/agent/[agentId]/transcript
 *
 *   200 { messages }
 *   400 agentId_required (when route param is empty)
 *   401 unauthorized
 *   404 not_found (also covers cross-user access)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: 'agentId_required' }, { status: 400 });
  }

  // Ownership check: agent_runs.teamId → teams.userId. Returning 404 on
  // both "row not found" and "row exists but team belongs to someone
  // else" prevents an attacker from probing for agentId existence.
  const ownerRows = await db
    .select({ userId: teams.userId })
    .from(agentRuns)
    .innerJoin(teams, eq(teams.id, agentRuns.teamId))
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  if (ownerRows.length === 0 || ownerRows[0].userId !== userId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // loadAgentRunHistory returns Anthropic.Messages.MessageParam[]; the
  // `content` field can be `string | ContentBlockParam[]`. Coerce here
  // so the drawer doesn't have to reinvent the structured-block renderer
  // — the typical case (plain text) is preserved verbatim and richer
  // shapes round-trip through JSON.stringify.
  const raw = await loadAgentRunHistory(agentId, db);
  const messages: TranscriptMessage[] = raw.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const body: TranscriptResponse = { messages };
  return NextResponse.json(body);
}
