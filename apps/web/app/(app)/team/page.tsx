/**
 * `/team` — founder's employee roster.
 *
 * Server component is a thin wrapper; all data fetching happens in the
 * client component since the MCP connection is browser→core direct (per
 * spec D13). The auth gate runs in `(app)/layout.tsx` so by the time this
 * renders we already have a valid session.
 */

import TeamClient from "./_components/team-client";

export default function TeamPage() {
  return (
    <div>
      <h1>Your Team</h1>
      <TeamClient />
    </div>
  );
}
