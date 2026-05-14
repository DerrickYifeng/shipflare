/**
 * Peer-DM shadow logger — Spec §6.1 invariant #2.
 *
 * When employee A calls employee B via RPC (e.g. SMM asks Copywriter for a
 * rewrite), A should record a quiet shadow message at the CMO so the CMO
 * has visibility into peer-DMs WITHOUT being woken every time peers chat.
 *
 * The CMO sees these on its next natural wake (founder message, cron tick,
 * etc.). The shadow MUST NOT trigger CMO's onMessage / chat handler — we
 * call CMO's `/internal/peer-dm-shadow` HTTP route, which performs a
 * silent `INSERT INTO employee_log (...)` and returns. We deliberately do
 * NOT use the MCP RPC tool surface here because that would route through
 * the agent's normal request handling path and could wake the LLM loop.
 *
 * This helper is callable from any employee that wants to peer-DM another.
 * Phase 2 P2-C ships SMM → Copywriter as the first concrete consumer.
 */

/**
 * Shape of a peer-DM shadow log entry. Matches the request body shape
 * expected by `apps/core/src/agents/cmo/CMO.ts → handlePeerShadow`.
 */
export interface PeerDmShadow {
  /** Optional CMO conversation correlation id. */
  conversationId?: string;
  /** Role slug of the employee initiating the peer-DM. */
  fromRole: string;
  /** Role slug of the peer being called. */
  toRole: string;
  /** MCP tool name on `toRole` that was invoked. */
  tool: string;
  /** Human-readable one-line summary surfaced in the CMO's review UI. */
  summary: string;
  /** Optional structured payload — kept opaque end-to-end. */
  payload?: unknown;
}

/**
 * Send a peer-DM shadow log to the CMO over its internal HTTP route.
 *
 * Errors here are intentionally surfaced to the caller — peer-DM tools
 * typically wrap this in a try/catch and treat shadow failure as
 * non-fatal so the underlying RPC result is still returned to the user.
 */
export async function logPeerDmShadow<T extends Rpc.DurableObjectBranded | undefined>(
  cmoNamespace: DurableObjectNamespace<T>,
  userId: string,
  shadow: PeerDmShadow,
): Promise<void> {
  const cmoId = cmoNamespace.idFromName(userId);
  const cmoStub = cmoNamespace.get(cmoId);
  const res = await cmoStub.fetch(
    new Request("https://internal/internal/peer-dm-shadow", {
      method: "POST",
      headers: {
        "x-shipflare-internal": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(shadow),
    }),
  );
  if (!res.ok) {
    throw new Error(
      `peer-dm-shadow log failed: ${res.status} ${await res.text()}`,
    );
  }
}
