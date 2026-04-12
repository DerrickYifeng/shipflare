'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="lg:hidden flex items-center justify-between px-4 h-14 border-b border-sf-border bg-sf-bg-primary sticky top-0 z-30">
      <Link href="/dashboard" className="text-[18px] font-semibold text-sf-text-primary tracking-tight">
        ShipFlare
      </Link>

      <nav className="flex items-center gap-1" aria-label="Mobile navigation">
        <Link
          href="/dashboard"
          className={`px-3 py-2 text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname === '/dashboard'
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Dashboard
        </Link>
        <Link
          href="/settings"
          className={`px-3 py-2 text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/settings')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Settings
        </Link>
      </nav>
    </header>
  );
}
