/**
 * `/team` — CF-native Team page.
 *
 * Server wrapper only — auth gate runs in `(app)/layout.tsx` but we also
 * read the session here so we can pass user metadata to the client component
 * (avatar, name for the composer). All CMO data fetching happens in the
 * browser via useCmoStub (spec D13: browser→core direct via callable RPC).
 */

import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { TeamDesk } from "./_components/team-desk";

export const dynamic = "force-dynamic";

export interface TeamUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export default async function TeamPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[TeamPage] getSession failed", err);
    session = null;
  }
  if (!session?.user) return null;
  return (
    <TeamDesk
      user={{
        id: session.user.id,
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
