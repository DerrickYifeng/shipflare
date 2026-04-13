'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutAction } from '@/app/actions/auth';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { href: '/agents', label: 'Agents', icon: AgentsIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex flex-col w-[200px] border-r border-sf-border bg-sf-bg-primary h-screen sticky top-0">
      <div className="px-5 py-5">
        <Link href="/dashboard" className="text-[18px] font-semibold text-sf-text-primary tracking-tight">
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
                    flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-sf-md)]
                    text-[13px] font-medium transition-colors duration-150
                    ${isActive
                      ? 'bg-sf-bg-secondary text-sf-text-primary'
                      : 'text-sf-text-secondary hover:bg-sf-bg-secondary hover:text-sf-text-primary'
                    }
                  `}
                >
                  <item.icon active={isActive} />
                  {item.label}
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
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[var(--radius-sf-md)] text-[13px] font-medium text-sf-text-secondary hover:bg-sf-bg-secondary hover:text-sf-text-primary transition-colors duration-150"
          >
            <LogOutIcon />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

function DashboardIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
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

function AgentsIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={active ? 'var(--color-sf-text-primary)' : 'currentColor'} strokeWidth="1.5">
      <circle cx="8" cy="4" r="2" />
      <path d="M4 14v-2a4 4 0 0 1 8 0v2" />
      <circle cx="3" cy="6" r="1.5" />
      <circle cx="13" cy="6" r="1.5" />
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
