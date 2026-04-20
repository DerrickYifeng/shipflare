import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { TeamContent } from './_components/team-content';

export const metadata: Metadata = {
  title: 'Your AI Team',
  description: 'Watch Nova, Ember, Sable, Arlo and Kit run your marketing pipeline in real time.',
};

/**
 * `/team` — v2 isometric office view ("Your AI Team"). Replaces the
 * previous `/automation` AgentsWarRoom. Auth-gated like the rest of the
 * `(app)` group; live state is provided by the `AgentStreamProvider`
 * mounted in `layout.tsx`.
 */
export default async function TeamPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  return <TeamContent />;
}
