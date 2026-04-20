'use client';

/**
 * Settings — v2 tabbed rebuild.
 *
 * Tabs: Appearance · Account · Billing · Integrations · Safety. Active tab
 * surfaces in the HeaderBar meta line. Toggle flips persist through
 * /api/preferences or the relevant per-integration endpoint.
 *
 * Pixel reference: handoff pages.jsx `SettingsView` + `Section*` panels.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { Switch } from '@/components/ui/switch';
import { FieldRow } from '@/components/ui/field-row';
import { useToast } from '@/components/ui/toast';
import { useTheme, type Theme } from '@/components/layout/theme-provider';
import { usePreferences } from '@/hooks/use-preferences';

type SectionId = 'appearance' | 'account' | 'billing' | 'integrations' | 'safety';

// Order matches the handoff prototype: Theme (Appearance) lives last by
// convention because it's a cosmetic tab. The `'appearance'` key is preserved
// for URL-hash stability (no existing deep links to `/settings#appearance`, but
// we keep the identifier stable in case external links appear).
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'billing', label: 'Billing' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'safety', label: 'Safety' },
  { id: 'appearance', label: 'Appearance' },
];

export interface SettingsUser {
  name: string | null;
  email: string | null;
  image: string | null;
  timezone: string | null;
}

export interface SettingsConnection {
  platform: 'reddit' | 'x';
  username: string | null;
  connected: boolean;
}

interface SettingsContentProps {
  user: SettingsUser;
  connections: SettingsConnection[];
}

function readInitialSection(): SectionId {
  // Default to the first section ('account') so fresh visits land on the
  // practical tab, not the cosmetic one.
  if (typeof window === 'undefined') return 'account';
  const hash = window.location.hash.slice(1) as SectionId;
  return SECTIONS.some((s) => s.id === hash) ? hash : 'account';
}

export function SettingsContent({ user, connections }: SettingsContentProps) {
  // Lazy init so we read the URL hash once on mount, not inside an effect —
  // avoids the react-hooks/set-state-in-effect lint rule and the cascading
  // render it protects against.
  const [section, setSection] = useState<SectionId>(readInitialSection);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.hash = section;
      window.history.replaceState(null, '', url);
    }
  }, [section]);

  const activeLabel = SECTIONS.find((s) => s.id === section)?.label;

  return (
    <>
      <HeaderBar title="Settings" meta={activeLabel} />

      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(180px, 220px) minmax(0, 1fr)',
            gap: 24,
            alignItems: 'flex-start',
          }}
          className="settings-grid"
        >
          <SettingsTabs active={section} onSelect={setSection} />

          <div style={{ minWidth: 0 }}>
            {section === 'appearance' && <AppearanceSection />}
            {section === 'account' && <AccountSection user={user} />}
            {section === 'billing' && <BillingSection />}
            {section === 'integrations' && (
              <IntegrationsSection connections={connections} />
            )}
            {section === 'safety' && <SafetySection />}
          </div>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 720px) {
          .settings-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
    </>
  );
}

function SettingsTabs({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (next: SectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        position: 'sticky',
        top: 72,
      }}
    >
      {SECTIONS.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={isActive ? 'page' : undefined}
            style={{
              textAlign: 'left',
              padding: '10px 14px',
              borderRadius: 'var(--sf-radius-md)',
              background: isActive ? 'var(--sf-paper-raised)' : 'transparent',
              border: 'none',
              color: isActive ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
              fontWeight: isActive ? 600 : 500,
              fontSize: 'var(--sf-text-sm)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: isActive ? 'var(--sf-shadow-sm)' : 'none',
              transition: 'all var(--sf-dur-fast) var(--sf-ease-swift)',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </nav>
  );
}

function SettingsPanel({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <Card padding={28}>
      <h2 className="sf-h3" style={{ margin: 0, color: 'var(--sf-fg-1)' }}>
        {title}
      </h2>
      {desc && (
        <p
          style={{
            margin: '6px 0 20px',
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
          }}
        >
          {desc}
        </p>
      )}
      {children}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Appearance
   ═══════════════════════════════════════════════════════════════════ */

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const swatches: {
    id: Theme;
    label: string;
    desc: string;
    paper: string;
    raised: string;
    fg: string;
    accent: string;
  }[] = [
    {
      id: 'light',
      label: 'Light',
      desc: 'Warm cream surfaces. Best in bright rooms.',
      paper: 'oklch(97.5% 0.010 75)',
      raised: 'oklch(100% 0 0)',
      fg: 'oklch(18% 0.020 265)',
      accent: 'oklch(58% 0.22 258)',
    },
    {
      id: 'dark',
      label: 'Dark',
      desc: 'Deep ink with signal glow. Matches the marketing page.',
      paper: 'oklch(14% 0.020 265)',
      raised: 'oklch(19% 0.024 265)',
      fg: 'oklch(98% 0.004 85)',
      accent: 'oklch(74% 0.19 258)',
    },
  ];

  return (
    <SettingsPanel
      title="Appearance"
      desc="How ShipFlare looks on your screen. Saved for next time you sign in."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
        }}
      >
        {swatches.map((s) => {
          const selected = theme === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setTheme(s.id)}
              aria-pressed={selected}
              style={{
                textAlign: 'left',
                padding: 0,
                background: 'transparent',
                border: `2px solid ${selected ? 'var(--sf-signal)' : 'var(--sf-border-subtle)'}`,
                borderRadius: 'var(--sf-radius-lg)',
                cursor: 'pointer',
                overflow: 'hidden',
                fontFamily: 'inherit',
                transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
                boxShadow: selected ? '0 0 0 3px oklch(58% 0.22 258 / 0.15)' : 'none',
              }}
            >
              <div
                style={{
                  background: s.paper,
                  padding: 16,
                  height: 140,
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 4,
                      background: s.fg,
                      opacity: 0.85,
                    }}
                  />
                  <span
                    style={{
                      width: 50,
                      height: 6,
                      borderRadius: 3,
                      background: s.fg,
                      opacity: 0.6,
                    }}
                  />
                  <span
                    style={{
                      marginLeft: 'auto',
                      width: 18,
                      height: 6,
                      borderRadius: 3,
                      background: s.accent,
                    }}
                  />
                </div>
                <div
                  style={{
                    background: s.raised,
                    borderRadius: 8,
                    padding: 10,
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    border:
                      s.id === 'dark'
                        ? '1px solid oklch(98% 0.004 85 / 0.08)'
                        : '1px solid oklch(18% 0.020 265 / 0.06)',
                  }}
                >
                  <span
                    style={{
                      width: '70%',
                      height: 6,
                      borderRadius: 3,
                      background: s.fg,
                      opacity: 0.85,
                    }}
                  />
                  <span
                    style={{
                      width: '90%',
                      height: 5,
                      borderRadius: 3,
                      background: s.fg,
                      opacity: 0.4,
                    }}
                  />
                  <span
                    style={{
                      width: '55%',
                      height: 5,
                      borderRadius: 3,
                      background: s.fg,
                      opacity: 0.4,
                    }}
                  />
                  <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
                    <span
                      style={{
                        width: 34,
                        height: 14,
                        borderRadius: 999,
                        background: s.accent,
                      }}
                    />
                    <span
                      style={{
                        width: 22,
                        height: 14,
                        borderRadius: 999,
                        background: s.fg,
                        opacity: 0.15,
                      }}
                    />
                  </div>
                </div>
              </div>
              <div
                style={{
                  padding: '12px 14px',
                  background: 'var(--sf-paper-raised)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  borderTop: '1px solid var(--sf-border-subtle)',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    border: `2px solid ${selected ? 'var(--sf-signal)' : 'var(--sf-border)'}`,
                    background: selected ? 'var(--sf-signal)' : 'transparent',
                    flexShrink: 0,
                    marginTop: 2,
                    position: 'relative',
                  }}
                >
                  {selected && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      style={{ position: 'absolute', top: 1, left: 1 }}
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 6L5 8.5L9.5 3.5"
                        stroke="#fff"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 'var(--sf-text-sm)',
                      fontWeight: 600,
                      color: 'var(--sf-fg-1)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {s.label}
                    {selected && (
                      <Badge variant="signal" mono>
                        ACTIVE
                      </Badge>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--sf-fg-3)',
                      marginTop: 3,
                      lineHeight: 1.4,
                    }}
                  >
                    {s.desc}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 20,
          padding: '12px 14px',
          background: 'var(--sf-paper-sunken)',
          borderRadius: 'var(--sf-radius-md)',
          fontSize: 'var(--sf-text-xs)',
          color: 'var(--sf-fg-3)',
          letterSpacing: 'var(--sf-track-normal)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5.5" />
          <path d="M7 4v3M7 9.5v.01" strokeLinecap="round" />
        </svg>
        You can also toggle themes from the icon in the top-right of the app.
      </div>
    </SettingsPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Account
   ═══════════════════════════════════════════════════════════════════ */

function AccountSection({ user }: { user: SettingsUser }) {
  const router = useRouter();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm('Permanently delete your account? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      router.push('/');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete account');
      setDeleting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SettingsPanel title="Account" desc="Your login info and profile.">
        <FieldRow label="Name">{user.name ?? '—'}</FieldRow>
        <FieldRow label="Email">{user.email ?? '—'}</FieldRow>
        <FieldRow label="Timezone">{user.timezone ?? 'America/Los_Angeles'}</FieldRow>
        <FieldRow label="Sign in" muted>
          <span style={{ color: 'var(--sf-fg-3)' }}>Managed through GitHub OAuth.</span>
        </FieldRow>
      </SettingsPanel>
      <DangerZone
        title="Danger zone"
        desc="Irreversible actions. Double-check before clicking."
      >
        <DangerRow
          label="Delete account"
          desc="Permanently wipe your account and all associated data. This cannot be undone."
          action={
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              style={{
                minHeight: 40,
                padding: '0 16px',
                borderRadius: 'var(--sf-radius-md)',
                background: 'var(--sf-danger)',
                color: 'var(--sf-fg-on-dark-1)',
                border: 'none',
                cursor: deleting ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                fontSize: 'var(--sf-text-sm)',
                fontFamily: 'inherit',
                letterSpacing: 'var(--sf-track-tight)',
                opacity: deleting ? 0.6 : 1,
                transition: 'opacity var(--sf-dur-base) var(--sf-ease-swift)',
              }}
            >
              {deleting ? 'Deleting…' : 'Permanently delete'}
            </button>
          }
        />
      </DangerZone>
    </div>
  );
}

/**
 * DangerZone — visually distinct card for destructive actions. Sits BELOW
 * the regular account settings so it's always the last thing on the tab.
 * 1px danger border + danger-tinted header so it reads as "different".
 */
function DangerZone({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--sf-paper-raised)',
        border: '1px solid var(--sf-danger)',
        borderRadius: 'var(--sf-radius-lg)',
        padding: 28,
        boxShadow: 'var(--sf-shadow-sm)',
      }}
    >
      <h2
        className="sf-h3"
        style={{ margin: 0, color: 'var(--sf-danger-ink)' }}
      >
        {title}
      </h2>
      {desc && (
        <p
          style={{
            margin: '6px 0 20px',
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
          }}
        >
          {desc}
        </p>
      )}
      {children}
    </div>
  );
}

function DangerRow({
  label,
  desc,
  action,
}: {
  label: string;
  desc?: string;
  action: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        paddingTop: 16,
        borderTop: '1px solid var(--sf-border-subtle)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 300px' }}>
        <div
          style={{
            fontSize: 'var(--sf-text-sm)',
            fontWeight: 600,
            color: 'var(--sf-fg-1)',
          }}
        >
          {label}
        </div>
        {desc && (
          <div
            style={{
              marginTop: 4,
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              lineHeight: 'var(--sf-lh-normal)',
            }}
          >
            {desc}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{action}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Billing (stub: shows plan info; real Stripe TBD per TODOS.md backlog)
   ═══════════════════════════════════════════════════════════════════ */

function BillingSection() {
  return (
    <>
      <SettingsPanel title="Plan" desc="Your current subscription and usage.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              padding: 18,
              borderRadius: 'var(--sf-radius-md)',
              background: 'var(--sf-ink)',
              color: 'var(--sf-fg-on-dark-1)',
            }}
          >
            <Ops
              tone="onDark"
              style={{
                display: 'block',
                marginBottom: 6,
              }}
            >
              CURRENT PLAN
            </Ops>
            <div style={{ fontSize: 'var(--sf-text-h3)', fontWeight: 600 }}>Beta</div>
            <div
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-on-dark-3)',
                marginTop: 4,
              }}
            >
              Free while we validate
            </div>
          </div>
          <div
            style={{
              padding: 18,
              borderRadius: 'var(--sf-radius-md)',
              background: 'var(--sf-paper-sunken)',
            }}
          >
            <Ops style={{ display: 'block', marginBottom: 6 }}>REPLIES THIS CYCLE</Ops>
            <div
              style={{
                fontSize: 'var(--sf-text-h3)',
                fontWeight: 500,
                fontFamily: 'var(--sf-font-mono)',
              }}
            >
              — <span style={{ color: 'var(--sf-fg-3)' }}>/ unlimited</span>
            </div>
          </div>
          <div
            style={{
              padding: 18,
              borderRadius: 'var(--sf-radius-md)',
              background: 'var(--sf-paper-sunken)',
            }}
          >
            <Ops style={{ display: 'block', marginBottom: 6 }}>TEAM SEATS</Ops>
            <div
              style={{
                fontSize: 'var(--sf-text-h3)',
                fontWeight: 500,
                fontFamily: 'var(--sf-font-mono)',
              }}
            >
              1 <span style={{ color: 'var(--sf-fg-3)' }}>/ 1</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" disabled>
            Change plan
          </Button>
          <Button variant="ghost" size="sm" disabled>
            Download invoices
          </Button>
        </div>
        <p
          style={{
            marginTop: 16,
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
          }}
        >
          Paid tiers arrive with Stripe integration. No action needed — all features are on
          during beta.
        </p>
      </SettingsPanel>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Integrations — real channel statuses
   ═══════════════════════════════════════════════════════════════════ */

function IntegrationsSection({
  connections,
}: {
  connections: SettingsConnection[];
}) {
  const { toast } = useToast();
  const router = useRouter();

  const handleDisconnect = async (platform: 'reddit' | 'x') => {
    try {
      const res = await fetch(`/api/${platform}/disconnect`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Disconnect failed');
      toast(`${platform} disconnected`);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not disconnect');
    }
  };

  const handleConnect = (platform: 'reddit' | 'x') => {
    window.location.href = `/api/${platform}/connect`;
  };

  const redditConn = connections.find((c) => c.platform === 'reddit');
  const xConn = connections.find((c) => c.platform === 'x');

  const integrations = [
    {
      name: 'X / Twitter',
      badge: xConn?.username ? `@${xConn.username} · OAuth` : 'Not connected',
      connected: xConn?.connected ?? false,
      onConnect: () => handleConnect('x'),
      onDisconnect: () => handleDisconnect('x'),
      icon: <XTileIcon />,
    },
    {
      name: 'Reddit',
      badge: redditConn?.username ? `u/${redditConn.username} · OAuth` : 'Not connected',
      connected: redditConn?.connected ?? false,
      onConnect: () => handleConnect('reddit'),
      onDisconnect: () => handleDisconnect('reddit'),
      icon: <RedditTileIcon />,
    },
    {
      name: 'Hacker News',
      badge: 'Read-only · public API',
      connected: true,
      readOnly: true,
      icon: <HnTileIcon />,
    },
    {
      name: 'Slack',
      badge: 'Coming soon',
      connected: false,
      readOnly: true,
      icon: <SlackTileIcon />,
    },
    {
      name: 'Webhook',
      badge: 'Coming soon',
      connected: false,
      readOnly: true,
      icon: <WebhookTileIcon />,
    },
  ];

  return (
    <SettingsPanel title="Integrations" desc="Connect the rails. Disconnect anytime.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {integrations.map((it) => (
          <div
            key={it.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: 14,
              borderRadius: 'var(--sf-radius-md)',
              background: 'var(--sf-paper-sunken)',
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'var(--sf-paper)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid var(--sf-border-subtle)',
                flexShrink: 0,
              }}
            >
              {it.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 'var(--sf-text-sm)',
                  fontWeight: 600,
                  color: 'var(--sf-fg-1)',
                }}
              >
                {it.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--sf-fg-3)',
                  marginTop: 2,
                  fontFamily: 'var(--sf-font-mono)',
                  letterSpacing: 'var(--sf-track-mono)',
                }}
              >
                {it.badge}
              </div>
            </div>
            {it.readOnly ? (
              <Badge>{it.connected ? 'Active' : 'Locked'}</Badge>
            ) : it.connected ? (
              <Button variant="ghost" size="sm" onClick={it.onDisconnect}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={it.onConnect}>
                Connect
              </Button>
            )}
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Safety — maps to userPreferences auto-approve fields
   ═══════════════════════════════════════════════════════════════════ */

function SafetySection() {
  const { preferences, update } = usePreferences();
  const { toast } = useToast();

  const autoApprove = preferences?.autoApproveEnabled ?? false;
  const notifyNewDraft = preferences?.notifyOnNewDraft ?? true;
  const notifyAutoApprove = preferences?.notifyOnAutoApprove ?? true;

  const handleToggle = async (
    key: 'autoApproveEnabled' | 'notifyOnNewDraft' | 'notifyOnAutoApprove',
    next: boolean,
  ) => {
    try {
      await update({ [key]: next });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save');
    }
  };

  return (
    <SettingsPanel
      title="Safety rails"
      desc="These run before anything ships. You stay in control."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ToggleRow
          label="Require human approval for every post"
          description="When enabled, nothing ships until you hit Approve on Today."
          checked={!autoApprove}
          onChange={(next) => void handleToggle('autoApproveEnabled', !next)}
        />
        <ToggleRow
          label="Notify me when a new draft is ready"
          description="Shows a toast + optional email when the drafting agent lands a reply."
          checked={notifyNewDraft}
          onChange={(next) => void handleToggle('notifyOnNewDraft', next)}
        />
        <ToggleRow
          label="Notify me when a draft auto-approves"
          description="Applies when auto-approve is on and a reply clears the confidence bar."
          checked={notifyAutoApprove}
          onChange={(next) => void handleToggle('notifyOnAutoApprove', next)}
        />
      </div>
    </SettingsPanel>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 0',
        borderBottom: '1px solid var(--sf-border-subtle)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-1)', fontWeight: 500 }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            marginTop: 2,
          }}
        >
          {description}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Brand icons — tiny inline SVGs for integrations tiles
   ═══════════════════════════════════════════════════════════════════ */

function XTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="X">
      <rect width="24" height="24" rx="4" fill="currentColor" style={{ color: 'var(--sf-ink)' }} />
      <path
        d="M16.8 5.5h2.3l-5 5.7L20 18.5h-4.6l-3.6-4.7-4.1 4.7H5.3l5.4-6.1L5 5.5h4.7l3.2 4.3 3.9-4.3z"
        fill="#fff"
      />
    </svg>
  );
}

function RedditTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="Reddit">
      <circle cx="12" cy="12" r="12" fill="#FF4500" />
      <g fill="#ffffff">
        <circle cx="12" cy="13.5" r="6.5" />
      </g>
      <g fill="#FF4500">
        <circle cx="9.6" cy="13" r="1.2" />
        <circle cx="14.4" cy="13" r="1.2" />
      </g>
      <path
        d="M9 15.8 Q12 17.8 15 15.8"
        stroke="#FF4500"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HnTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="Hacker News">
      <rect width="24" height="24" rx="2" fill="#FF6600" />
      <path d="M11 13.5 7.3 6.5h1.9l2.3 4.5 2.3-4.5h1.9L12 13.5V17h-1z" fill="#ffffff" />
    </svg>
  );
}

function SlackTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="Slack">
      <rect x="5" y="5" width="5" height="5" rx="1.5" fill="#2EB67D" />
      <rect x="14" y="5" width="5" height="5" rx="1.5" fill="#E01E5A" />
      <rect x="14" y="14" width="5" height="5" rx="1.5" fill="#ECB22E" />
      <rect x="5" y="14" width="5" height="5" rx="1.5" fill="#36C5F0" />
    </svg>
  );
}

function WebhookTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="Webhook">
      <rect width="24" height="24" rx="4" fill="#C73A63" />
      <g fill="#ffffff">
        <circle cx="9" cy="16" r="2" />
        <circle cx="15" cy="16" r="2" />
        <circle cx="12" cy="8" r="2" />
      </g>
    </svg>
  );
}
