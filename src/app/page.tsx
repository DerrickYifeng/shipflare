import { auth } from '@/lib/auth';
import { GlassNav } from '@/components/marketing/glass-nav';
import { HeroDemo } from '@/components/marketing/hero-demo';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { PhaseSection } from '@/components/marketing/phase-section';
import { VideoSection } from '@/components/marketing/video-section';
import { ThreadsSection } from '@/components/marketing/threads-section';
import { SafetySection } from '@/components/marketing/safety-section';
import { CTASection } from '@/components/marketing/cta-section';
import { FooterStrip } from '@/components/marketing/footer-strip';
import { AccessDeniedBanner } from '@/components/marketing/access-denied-banner';

/**
 * Marketing landing — strict alternating ink ↔ paper rhythm:
 *   Hero (ink) → HowItWorks (paper, six agents) → VideoSection (ink, demo)
 *   → PhaseSection (paper, six phases) → ThreadsSection (ink) →
 *   SafetySection (paper) → CTA (ink, with signal gradient) → Footer (paper)
 *
 * Do NOT wrap this page in `.app-dark` — that would remap `--sf-bg-primary`.
 * Dark sections set their own bg + on-dark fg, so this works without theme.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;
  const sp = await searchParams;
  const accessDenied = sp.error === 'AccessDenied';

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--sf-bg-dark)' }}
    >
      <GlassNav isAuthenticated={isAuthenticated} />
      {accessDenied ? <AccessDeniedBanner /> : null}
      <HeroDemo isAuthenticated={isAuthenticated} />
      <HowItWorks />
      <VideoSection />
      <PhaseSection />
      <ThreadsSection />
      <SafetySection />
      <CTASection isAuthenticated={isAuthenticated} />
      <FooterStrip />
    </main>
  );
}
