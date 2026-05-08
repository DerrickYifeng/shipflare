import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels, userPreferences } from '@/lib/db/schema';
import { SettingsContent, type SettingsConnection } from './settings-content';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  // Whitelist select — never echo oauth token columns outside of platform-deps.
  const userChannels = await db
    .select({
      platform: channels.platform,
      username: channels.username,
    })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  const [prefs] = await db
    .select({ timezone: userPreferences.timezone })
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);

  // Reddit is intentionally omitted: it's a no-binding always-on channel
  // (handoff dispatch + RedditClient.appOnly() reads), so the settings UI
  // surfaces it as a read-only "Always on" tile rather than a connection.
  const connections: SettingsConnection[] = [
    {
      platform: 'x',
      username: userChannels.find((c) => c.platform === 'x')?.username ?? null,
      connected: userChannels.some((c) => c.platform === 'x'),
    },
  ];

  return (
    <SettingsContent
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
        timezone: prefs?.timezone ?? null,
      }}
      connections={connections}
    />
  );
}
