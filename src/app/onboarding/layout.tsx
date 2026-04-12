import type { ReactNode } from 'react';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sf-bg-secondary p-4">
      <div className="w-full max-w-xl bg-sf-bg-primary border border-sf-border rounded-[var(--radius-sf-lg)] p-8">
        {children}
      </div>
    </main>
  );
}
