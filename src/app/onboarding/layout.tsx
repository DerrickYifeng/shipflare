import type { ReactNode } from 'react';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sf-bg-primary p-4">
      <div className="w-full max-w-xl bg-sf-bg-secondary rounded-[var(--radius-sf-lg)] shadow-[var(--shadow-sf-elevated)] p-8">
        {children}
      </div>
    </main>
  );
}
