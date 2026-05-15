// Phase 1 landing page. S7 replaces this with the founder dashboard
// (chat, team roster, plan view, drafts). For now it's a single sign-in CTA.

import { SignInButton } from "./_components/sign-in-button";

// Disable static prerender so we never bake `s-maxage=31536000` into the
// landing page response. Without this, every deploy requires a manual
// Cloudflare edge cache purge to bust the year-long cache.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>ShipFlare</h1>
      <p>Your AI marketing team.</p>
      <SignInButton />
    </main>
  );
}
