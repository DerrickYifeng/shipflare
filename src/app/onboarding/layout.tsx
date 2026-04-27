import type { ReactNode } from 'react';

// Full-bleed layout — onboarding is its own world (no app shell).
// Spec: 2026-04-20-onboarding-frontend-design.md §3.1.
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-sf-bg-primary">{children}</div>;
}
