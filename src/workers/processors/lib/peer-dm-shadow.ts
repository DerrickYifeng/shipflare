// peer-DM-shadow helper — engine PDF §3.6.1 channel ③.
//
// When teammate-to-teammate `type:message` is sent, also insert a
// summary-only shadow row to the lead's mailbox. This gives the lead
// "I see what peers are talking about" visibility WITHOUT actively
// waking the lead — a key engine invariant: peer DMs must not generate
// scheduling pressure on the lead.
//
// Phase B kludge: if the lead has no agent_runs row yet (leadAgentId
// is null), skip the insert. The lead's polling drain in team-run will
// naturally pick up these shadows when wired in Phase E (X model).

import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const SYSTEM_AGENT_ID = '__system__';

export interface PeerDmShadowInput {
  teamId: string;
  leadAgentId: string | null;
  fromName: string;
  toName: string;
  summary: string;
  db: Database;
}

/**
 * Insert a peer-DM visibility shadow row to the lead's mailbox.
 *
 * **Architecture-critical invariant**: this function MUST NOT call
 * `wake()`. Peer DMs shall not preemptively wake the lead — the lead
 * sees these shadows on its NEXT natural wake (task notification or
 * founder message). Removing this invariant is a review-reject.
 */
export async function insertPeerDmShadow({
  teamId,
  leadAgentId,
  fromName,
  toName,
  summary,
  db,
}: PeerDmShadowInput): Promise<void> {
  if (leadAgentId === null) {
    // Phase B kludge: lead has no agent_runs row yet. Phase E lifts this.
    return;
  }
  const content =
    `<peer-dm from="${escapeXml(fromName)}" to="${escapeXml(toName)}">` +
    `${escapeXml(summary)}` +
    `</peer-dm>`;
  await db.insert(teamMessages).values({
    teamId,
    type: 'user_prompt',
    messageType: 'message',
    fromAgentId: SYSTEM_AGENT_ID,
    toAgentId: leadAgentId,
    content,
    summary,
  });
  // CRITICAL: no wake() call here. See JSDoc above.
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}
