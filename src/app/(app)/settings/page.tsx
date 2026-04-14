import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { HeaderBar } from '@/components/layout/header-bar';
import { ProfileSection } from '@/components/settings/profile-section';
import { ConnectionsSection } from '@/components/settings/connections-section';
import { AutomationSection } from '@/components/settings/automation-section';
import { DangerZone } from '@/components/settings/danger-zone';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const userChannels = await db
    .select()
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
        <DangerZone />
      </div>
    </>
  );
}
