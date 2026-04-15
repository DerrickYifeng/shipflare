'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutAction } from '@/app/actions/auth';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';
import { usePipeline } from '@/components/ui/pipeline-provider';

const navItems = [
  { href: '/today', label: 'Today', icon: TodayIcon },
  { href: '/product', label: 'My Product', icon: ProductIcon },
  { href: '/growth', label: 'Growth', icon: GrowthIcon },
  { href: '/calendar', label: 'Calendar', icon: CalendarIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const { hasRunning } = usePipeline();

  return (
    <aside className="hidden lg:flex flex-col w-[200px] bg-black/[0.03] backdrop-blur-xl h-screen sticky top-0 border-r border-sf-border">
      <div className="px-5 py-5">
        <Link href="/today" className="text-[17px] font-semibold text-sf-text-primary tracking-[-0.374px] inline-flex items-center gap-2 min-h-[44px]">
          <ShipFlareLogo size={22} />
          ShipFlare
        </Link>
      </div>

      <nav className="flex-1 px-3" aria-label="Main navigation">
        <ul className="flex flex-col gap-0.5">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`
                    flex items-center gap-3 px-3 min-h-[44px] rounded-[var(--radius-sf-md)]
                    text-[14px] tracking-[-0.224px] transition-all duration-200
                    ${isActive
                      ? 'bg-black/[0.06] text-sf-text-primary font-medium'
                      : 'text-sf-text-secondary hover:bg-black/[0.04] hover:text-sf-text-primary'
                    }
                  `}
                >
                  <item.icon active={isActive} />
                  {item.label}
                  {hasRunning && item.href === '/calendar' && (
                    <span className="ml-auto w-2 h-2 rounded-full bg-sf-accent animate-pulse" aria-label="Pipeline running" />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-3 pb-4 mt-auto">
        <form action={signOutAction}>
          <button
            type="submit"
            className="flex items-center gap-3 w-full px-3 min-h-[44px] rounded-[var(--radius-sf-md)] text-[14px] tracking-[-0.224px] text-sf-text-secondary hover:bg-black/[0.04] hover:text-sf-text-primary transition-all duration-200"
          >
            <LogOutIcon />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

function TodayIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4v4l2.5 1.5" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3M11 11l3-3-3-3M14 8H6" />
    </svg>
  );
}

function ProductIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <path d="M2 5l6-3 6 3-6 3-6-3z" />
      <path d="M2 5v6l6 3V8" />
      <path d="M14 5v6l-6 3V8" />
    </svg>
  );
}

function GrowthIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <path d="M1 14l4-5 3 3 7-9" />
      <path d="M11 3h4v4" />
    </svg>
  );
}

function CalendarIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="12" rx="1" />
      <path d="M11 1v4M5 1v4M2 7h12" />
    </svg>
  );
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" />
    </svg>
  );
}
