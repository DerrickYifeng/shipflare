/**
 * `/memory` — founder's long-term memory store for the CMO (P2-D).
 *
 * Lists every active `cross_conversation_memory` row from the CMO DO. Each
 * row was added by the founder clicking "Remember" on a CMO message in
 * `/chat`. Clicking "Forget" soft-deletes (sets `active=0`); audit trail is
 * preserved server-side.
 *
 * Server component is a thin wrapper; the MCP fetch + forget loop runs in
 * the client (browser→core direct, per spec D13). Auth gate lives in
 * `(app)/layout.tsx`.
 */

import MemoryClient from "./_components/memory-client";

export default function MemoryPage() {
  return (
    <div>
      <h1>Long-term Memory</h1>
      <p style={{ color: "#666" }}>
        Things your CMO remembers across all conversations. Click
        &ldquo;Forget&rdquo; to deactivate. Add new memories by clicking
        &ldquo;Remember&rdquo; on CMO messages in chat.
      </p>
      <MemoryClient />
    </div>
  );
}
