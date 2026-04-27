import type { CSSProperties } from 'react';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';

interface FooterLink {
  label: string;
  href: string;
}

const FOOTER_LINKS: FooterLink[] = [
  { label: 'Docs', href: '#' },
  { label: 'Changelog', href: '#' },
  { label: 'Terms', href: '#' },
  { label: 'Privacy', href: '#' },
];

/**
 * Compact footer strip — dark ink bg, wordmark left, link cluster right.
 */
export function FooterStrip() {
  const linkStyle: CSSProperties = {
    color: 'var(--sf-fg-on-dark-4)',
    textDecoration: 'none',
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'uppercase',
    fontSize: 'var(--sf-text-2xs)',
    letterSpacing: 'var(--sf-track-mono)',
  };

  return (
    <footer
      style={{
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-4)',
        padding: 24,
        borderTop: '1px solid var(--sf-border-on-dark)',
      }}
    >
      <div
        className="flex items-center justify-between flex-wrap"
        style={{
          maxWidth: 'var(--sf-max-width)',
          margin: '0 auto',
          gap: 16,
        }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <ShipFlareLogo size={18} />
          <span
            style={{
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-on-dark-4)',
              letterSpacing: 'var(--sf-track-normal)',
            }}
          >
            ShipFlare · AI marketing autopilot for indie devs
          </span>
        </div>
        <nav className="flex" style={{ gap: 24 }} aria-label="Footer">
          {FOOTER_LINKS.map((link) => (
            <a key={link.label} href={link.href} style={linkStyle}>
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
