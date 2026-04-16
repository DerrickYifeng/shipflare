'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PLATFORMS } from '@/lib/platform-config';

interface GrowthChannel {
  href: string;
  label: string;
  icon: () => ReactNode;
}

// Map of platform id -> UI channel metadata. Only platforms with a Growth page
// should appear here; today that's just X.
const channelByPlatform: Record<string, GrowthChannel> = {
  x: { href: '/growth/x', label: 'X / Twitter', icon: XIcon },
};

export default function GrowthLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Note: isPlatformAvailable() reads process.env which isn't exposed client-side
  // for non-NEXT_PUBLIC_* vars. Gate purely on whether a Growth UI exists for the
  // platform; server pages still enforce auth/availability upstream.
  const channels = Object.keys(PLATFORMS)
    .filter((id) => channelByPlatform[id])
    .map((id) => channelByPlatform[id]);

  // Hide the top tab bar when there's only one growth channel — it adds noise
  // without offering real navigation. Auto-restores once a second platform ships.
  const showTabs = channels.length > 1;

  return (
    <div className="flex-1 flex flex-col">
      {showTabs && (
        <div className="border-b border-sf-border bg-sf-bg-primary px-6">
          <nav className="flex items-center gap-1" aria-label="Growth channels">
            {channels.map((ch) => {
              const isActive = pathname.startsWith(ch.href);
              return (
                <Link
                  key={ch.href}
                  href={ch.href}
                  className={`
                    flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium
                    border-b-2 -mb-px transition-colors duration-150
                    ${isActive
                      ? 'border-sf-accent text-sf-text-primary'
                      : 'border-transparent text-sf-text-secondary hover:text-sf-text-primary'
                    }
                  `}
                >
                  <ch.icon />
                  {ch.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
      {children}
    </div>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231z" />
    </svg>
  );
}
