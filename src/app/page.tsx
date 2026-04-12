import { auth } from '@/lib/auth';
import { LandingPage } from '@/components/landing/landing-page';

export default async function HomePage() {
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  return <LandingPage isAuthenticated={isAuthenticated} />;
}
