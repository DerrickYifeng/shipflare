/**
 * `/chat` — Founder-facing CMO chat surface.
 *
 * Server wrapper only — auth gate runs in `(app)/layout.tsx` but we also
 * read the session here so we can pass the userId to CmoChat. All WS
 * transport happens in the browser via useCmoChat (Task 8.2).
 */

import { headers } from "next/headers";
import { getAuth } from "@/auth";
import { CmoChat } from "./_components/cmo-chat";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
	let session = null;
	try {
		session = await getAuth().api.getSession({ headers: await headers() });
	} catch (err) {
		console.error("[ChatPage] getSession failed", err);
		session = null;
	}
	if (!session?.user) return null;
	return <CmoChat userId={session.user.id} />;
}
