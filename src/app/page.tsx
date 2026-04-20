import { auth } from '@/lib/auth';
import { GlassNav } from '@/components/marketing/glass-nav';
import { HeroDemo } from '@/components/marketing/hero-demo';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { ThreadsSection } from '@/components/marketing/threads-section';
import { SafetySection } from '@/components/marketing/safety-section';
import { CTASection } from '@/components/marketing/cta-section';
import { FooterStrip } from '@/components/marketing/footer-strip';

/**
 * Marketing landing — ShipFlare v2 (Phase 7).
 * Dark-only: root container carries `.app-dark` so the paper-background
 * sections (How It Works, Safety) re-theme to their dark equivalents via
 * the globals.css `.app-dark` remap — no per-section dark branches.
 */
export default async function HomePage() {
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  return (
    <main className="app-dark min-h-screen flex flex-col">
      <GlassNav isAuthenticated={isAuthenticated} />
      <HeroDemo isAuthenticated={isAuthenticated} />
      <HowItWorks />
      <ThreadsSection />
      <SafetySection />
      <CTASection isAuthenticated={isAuthenticated} />
      <FooterStrip />
    </main>
  );
}
