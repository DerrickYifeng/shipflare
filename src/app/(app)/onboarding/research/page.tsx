import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { HeaderBar } from '@/components/layout/header-bar';
import { RedditResearchCard } from '@/components/onboarding/reddit-research-card';

/**
 * /onboarding/research — the founder lands here after `/api/onboarding/commit`
 * so they can watch the kickoff Reddit-channel research finish and edit the
 * subreddit list before any plan_items reference it.
 *
 * Page is server-rendered; the card itself is a client component that
 * polls the status + channels endpoints over SWR.
 */
export default async function OnboardingResearchPage() {
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
        <p
          style={{
            margin: 0,
            color: 'var(--color-sf-text-secondary, #555)',
          }}
        >
          ShipFlare picks the three subreddits where your ICP is most likely
          to engage. You can swap, disable, or add your own at any time.
        </p>
        <RedditResearchCard />
      </main>
    </div>
  );
}
