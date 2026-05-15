import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { HeaderBar } from '@/components/layout/header-bar';
import { RedditResearchCard } from '@/components/onboarding/reddit-research-card';

export const metadata: Metadata = { title: 'Reddit communities' };

/**
 * /growth/reddit-channels — founder-managed view of the auto + manual
 * subreddits ShipFlare uses for Reddit content_post plan_items.
 *
 * Same `<RedditResearchCard />` that ships during onboarding —
 * this page just wraps it in the app shell so the founder can disable
 * a sub, swap in their own, or re-research at any time after kickoff.
 *
 * Reachable from the Reddit card on /growth ("Manage subreddits →").
 */
export default async function SettingsRedditChannelsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/');
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--sf-bg-primary)',
      }}
    >
      <HeaderBar title="Reddit communities" />
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: '24px 16px 48px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <p style={{ margin: 0, color: 'var(--sf-fg-2)' }}>
          Manage the subreddits ShipFlare uses when planning your Reddit
          posts. Disable any sub you&apos;d rather not target, swap in your
          own, or re-research from scratch.
        </p>
        <RedditResearchCard />
      </main>
    </div>
  );
}
