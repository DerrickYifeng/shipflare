import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/auth";
import { GlassNav } from "@/components/marketing/glass-nav";
import { FooterStrip } from "@/components/marketing/footer-strip";
import { WaitlistCard } from "./_components/waitlist-card";

export const dynamic = "force-dynamic";

interface WaitlistPageProps {
  searchParams: Promise<{
    from?: string;
    email?: string;
    reason?: string;
  }>;
}

export const metadata = {
  title: "Request access — ShipFlare",
  robots: { index: false, follow: false },
};

export default async function WaitlistPage({ searchParams }: WaitlistPageProps) {
  // Already signed in → no point showing the waitlist. Drop them at the
  // briefing (which itself gates on onboarding-completion).
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (session?.user) redirect("/briefing");

  const sp = await searchParams;
  // Mirror Railway's variant logic — used to swap headline copy.
  const variant =
    sp.reason === "no-email"
      ? "no-email"
      : sp.from === "denied"
        ? "denied"
        : "landing";

  // Basic email sanitization (avoid XSS via raw query param echoing).
  const rawEmail = sp.email ?? "";
  const emailLooksOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) && rawEmail.length <= 254;
  const initialEmail = emailLooksOk ? rawEmail : "";

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: "var(--sf-bg-dark)" }}
    >
      <GlassNav isAuthenticated={false} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <WaitlistCard variant={variant} initialEmail={initialEmail} />
      </div>
      <FooterStrip />
    </main>
  );
}
