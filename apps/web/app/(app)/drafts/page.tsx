/**
 * `/drafts` — founder's approval queue for SMM-generated drafts.
 *
 * Server component is a thin wrapper; the actual MCP fetch + approve loop
 * runs in the client (browser→core direct, per spec D13). The auth gate
 * lives in `(app)/layout.tsx` so by the time this renders we already have
 * a valid session.
 */

import DraftsClient from "./_components/drafts-client";

export default function DraftsPage() {
  return (
    <div>
      <h1>Drafts</h1>
      <DraftsClient />
    </div>
  );
}
