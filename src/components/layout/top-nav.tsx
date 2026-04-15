'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutAction } from '@/app/actions/auth';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="lg:hidden flex items-center justify-between px-4 h-12 bg-black/[0.8] backdrop-blur-[20px] backdrop-saturate-[180%] sticky top-0 z-30">
      <Link href="/today" className="text-[14px] font-semibold text-white tracking-[-0.224px] inline-flex items-center gap-2">
        <ShipFlareLogo size={20} />
        ShipFlare
      </Link>

      <nav className="flex items-center gap-0.5" aria-label="Mobile navigation">
        <NavLink href="/today" current={pathname === '/today'}>Today</NavLink>
        <NavLink href="/product" current={pathname.startsWith('/product')}>Product</NavLink>
        <NavLink href="/growth" current={pathname.startsWith('/growth')}>Growth</NavLink>
        <NavLink href="/calendar" current={pathname.startsWith('/calendar')}>Calendar</NavLink>
        <NavLink href="/settings" current={pathname.startsWith('/settings')}>Settings</NavLink>
        <form action={signOutAction}>
          <button
            type="submit"
            className="px-2.5 min-h-[44px] inline-flex items-center text-[12px] text-white/60 hover:text-white transition-colors duration-200"
          >
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}

function NavLink({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-2.5 min-h-[44px] inline-flex items-center text-[12px] transition-colors duration-200 ${
        current
          ? 'text-white font-medium'
          : 'text-white/60 hover:text-white'
      }`}
    >
      {children}
    </Link>
  );
}
