import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { HeaderBar } from '@/components/layout/header-bar';

export const metadata: Metadata = { title: 'Settings' };
import { ProfileSection } from '@/components/settings/profile-section';
import { ConnectionsSection } from '@/components/settings/connections-section';
import { AutomationSection } from '@/components/settings/automation-section';
import { VoiceSection } from '@/components/settings/voice-section';
import { TimezoneSection } from '@/components/settings/timezone-section';
import { DangerZone } from '@/components/settings/danger-zone';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  // Whitelist select — never echo oauth token fields to the app layer
  const userChannels = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      username: channels.username,
      tokenExpiresAt: channels.tokenExpiresAt,
      createdAt: channels.createdAt,
      updatedAt: channels.updatedAt,
    })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  const redditChannel = userChannels.find((c) => c.platform === 'reddit');
  const xChannel = userChannels.find((c) => c.platform === 'x');

  return (
    <>
      <HeaderBar title="Settings" />
      <div className="max-w-[640px] mx-auto p-6 flex flex-col gap-8">
        <ProfileSection user={session.user} />
        <ConnectionsSection
          redditConnected={!!redditChannel}
          redditUsername={redditChannel?.username ?? null}
          xConnected={!!xChannel}
          xUsername={xChannel?.username ?? null}
        />
        <AutomationSection />
        <VoiceSection />
        <TimezoneSection />
        <DangerZone />
      </div>
    </>
  );
}
