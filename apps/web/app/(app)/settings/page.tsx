import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { channels, userPreferences } from "@shipflare/db";
import { SettingsContent } from "./settings-content";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getAuth().api.getSession({
    headers: await headers(),
  });
  if (!session?.user) return null;
  const userId = session.user.id;

  const { env } = getCloudflareContext();
  const db = getDb(env);

  // Whitelist columns — never select `oauthTokenEncrypted` (per CLAUDE.md security TODO).
  const userChannels = await db
    .select({ platform: channels.platform, username: channels.username })
    .from(channels)
    .where(eq(channels.userId, userId))
    .all();

  const prefsRow = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .get();

  return (
    <SettingsContent
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }}
      channels={userChannels}
      preferences={{
        timezone: prefsRow?.timezone ?? "UTC",
        theme: (prefsRow?.theme ?? "light") as "light" | "dark",
      }}
    />
  );
}
