import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { GlassNav } from '@/components/marketing/glass-nav';
import { FooterStrip } from '@/components/marketing/footer-strip';
import { ContextBanner, type BannerVariant } from './_components/context-banner';
import { WaitlistForm } from './_components/waitlist-form';

interface WaitlistPageProps {
  searchParams: Promise<{
    from?: string;
    email?: string;
    reason?: string;
  }>;
}

const emailSchema = z.string().email().max(254);

export default async function WaitlistPage({ searchParams }: WaitlistPageProps) {
  // Already signed in → no point showing the waitlist
  const session = await auth();
  if (session?.user?.id) redirect('/today');

  const sp = await searchParams;

  // Determine which banner variant to show
  const variant: BannerVariant =
    sp.reason === 'no-email'
      ? 'no-email'
      : sp.from === 'denied'
        ? 'denied'
        : 'landing';

  // Pre-fill email only if it parses as a valid email — XSS guard
  const parsed = emailSchema.safeParse(sp.email);
  const initialEmail = parsed.success ? parsed.data : '';

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--sf-bg-dark)' }}
    >
      <GlassNav isAuthenticated={false} />
      <div className="flex-1 flex flex-col">
        <ContextBanner variant={variant} />
        <WaitlistForm initialEmail={initialEmail} referer={variant} />
      </div>
      <FooterStrip />
    </main>
  );
}

export const metadata = {
  title: 'Request alpha access — ShipFlare',
  robots: { index: false, follow: false },
};
