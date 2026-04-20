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
 *
 * The handoff README specifies an alternating rhythm:
 *   GlassNav (glass dark) → Hero (ink) → HowItWorks (paper) →
 *   Threads (ink) → Safety (paper) → CTA (signal gradient) →
 *   Footer (ink)
 *
 * **Do NOT** wrap this page in `.app-dark` — that would remap `--sf-paper`
 * to the dark-theme equivalent and collapse every section to black, which
 * is exactly what we don't want. Dark sections are self-contained: they
 * explicitly set `background: var(--sf-ink)` + `color: var(--sf-fg-on-dark-*)`
 * so they render correctly without any theme cascade. Light sections keep
 * their natural paper palette because the root is unthemed.
 */
export default async function HomePage() {
  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--sf-ink)' }}
    >
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
