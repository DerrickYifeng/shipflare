import type { ReactNode } from "react";

/**
 * Full-bleed onboarding layout. No app shell — onboarding is its own
 * focused surface that the founder hits once before the dashboard. The
 * (app)/layout.tsx gate sends them here when no `products` row exists.
 */
export const dynamic = "force-dynamic";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--sf-bg-primary)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  );
}
