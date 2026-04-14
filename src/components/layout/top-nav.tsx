'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutAction } from '@/app/actions/auth';

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
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname === '/dashboard'
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Dashboard
        </Link>
        <Link
          href="/product"
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/product')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          My Product
        </Link>
        <Link
          href="/automation"
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/automation')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Automation
        </Link>
        <Link
          href="/growth"
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/growth')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Growth
        </Link>
        <Link
          href="/calendar"
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/calendar')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Calendar
        </Link>
        <Link
          href="/settings"
          className={`px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
            pathname.startsWith('/settings')
              ? 'bg-sf-bg-secondary text-sf-text-primary'
              : 'text-sf-text-secondary'
          }`}
        >
          Settings
        </Link>
        <form action={signOutAction}>
          <button
            type="submit"
            className="px-3 min-h-[44px] inline-flex items-center text-[13px] font-medium rounded-[var(--radius-sf-md)] text-sf-text-secondary hover:bg-sf-bg-secondary hover:text-sf-text-primary transition-colors"
          >
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}
