'use client';

/**
 * Settings — tabbed page.
 *
 * Tabs: Account · Billing · Integrations · Appearance
 *
 * Safety tab is intentionally hidden (hidden since 2026-05-12 in Railway;
 * auto-approve / notify fields were dropped in the CF migration). The
 * SafetySection function is removed entirely — its backing DB columns no
 * longer exist.
 *
 * Reddit is always-on / no-binding per CLAUDE.md: it does NOT appear in the
 * Integrations tab. Only X (OAuth-bound) lives here.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { FieldRow } from '@/components/ui/field-row';
import { useToast } from '@/components/ui/toast';
import { useTheme, type Theme } from '@/components/layout/theme-provider';
import { usePreferences } from '@/hooks/use-preferences';

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

type SectionId = 'account' | 'billing' | 'integrations' | 'appearance';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'billing', label: 'Billing' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'appearance', label: 'Appearance' },
];

interface SettingsContentProps {
  user: { name: string | null; email: string | null; image: string | null };
  channels: Array<{ platform: string; username: string | null }>;
  preferences: { timezone: string; theme: 'light' | 'dark' };
}

function readInitialSection(): SectionId {
  if (typeof window === 'undefined') return 'account';
  const hash = window.location.hash.slice(1) as SectionId;
  return SECTIONS.some((s) => s.id === hash) ? hash : 'account';
}

/* ═══════════════════════════════════════════════════════════════════
   Root component
   ═══════════════════════════════════════════════════════════════════ */

export function SettingsContent({
  user,
  channels,
  preferences,
}: SettingsContentProps) {
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
            {section === 'appearance' && (
              <AppearanceSection initialTheme={preferences.theme} />
            )}
            {section === 'account' && (
              <AccountSection user={user} timezone={preferences.timezone} />
            )}
            {section === 'billing' && <BillingSection />}
            {section === 'integrations' && (
              <IntegrationsSection channels={channels} />
            )}
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

/* ═══════════════════════════════════════════════════════════════════
   Tab nav
   ═══════════════════════════════════════════════════════════════════ */

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
            role="tab"
            onClick={() => onSelect(s.id)}
            aria-current={isActive ? 'page' : undefined}
            aria-selected={isActive}
            style={{
              textAlign: 'left',
              padding: '10px 14px',
              borderRadius: 'var(--sf-radius-md)',
              background: isActive ? 'var(--sf-bg-secondary)' : 'transparent',
              border: 'none',
              color: isActive ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
              fontWeight: isActive ? 600 : 500,
              fontSize: 'var(--sf-text-sm)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: isActive ? 'var(--sf-shadow-card)' : 'none',
              transition: 'all var(--sf-dur-fast) var(--sf-ease)',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Panel wrapper
   ═══════════════════════════════════════════════════════════════════ */

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

function AppearanceSection({ initialTheme }: { initialTheme: 'light' | 'dark' }) {
  const { theme, setTheme } = useTheme();
  const { update } = usePreferences();

  // Use the server-provided initial theme until client hydrates
  const activeTheme = theme ?? initialTheme;

  const handleThemeSelect = useCallback(
    async (next: Theme) => {
      setTheme(next);
      try {
        await update({ theme: next });
      } catch {
        // Non-critical — localStorage already persists it
      }
    },
    [setTheme, update],
  );

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
          const selected = activeTheme === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => void handleThemeSelect(s.id)}
              aria-pressed={selected}
              style={{
                textAlign: 'left',
                padding: 0,
                background: 'transparent',
                border: `2px solid ${selected ? 'var(--sf-accent)' : 'var(--sf-border-subtle)'}`,
                borderRadius: 'var(--sf-radius-lg)',
                cursor: 'pointer',
                overflow: 'hidden',
                fontFamily: 'inherit',
                transition: 'all var(--sf-dur-base) var(--sf-ease)',
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
                  background: 'var(--sf-bg-secondary)',
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
                    border: `2px solid ${selected ? 'var(--sf-accent)' : 'var(--sf-border)'}`,
                    background: selected ? 'var(--sf-accent)' : 'transparent',
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
                      <Badge variant="accent" mono>
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
          background: 'var(--sf-bg-tertiary)',
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

/**
 * Delete confirmation dialog — requires typing "DELETE" to unlock the button.
 * Replaces window.confirm() so Playwright can interact with it deterministically.
 */
function DeleteAccountDialog({
  open,
  onClose,
  onConfirm,
  confirming,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const [typed, setTyped] = useState('');
  const canDelete = typed === 'DELETE';

  // Reset input when dialog opens/closes
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--sf-z-modal, 1000)' as string,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'oklch(0% 0 0 / 0.45)',
          backdropFilter: 'blur(6px)',
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          background: 'var(--sf-bg-secondary)',
          borderRadius: 'var(--sf-radius-lg)',
          padding: 28,
          width: '100%',
          maxWidth: 440,
          boxShadow: 'var(--sf-shadow-elevated)',
        }}
      >
        <h2
          id="delete-dialog-title"
          className="sf-h3"
          style={{ margin: '0 0 8px', color: 'var(--sf-error-ink)' }}
        >
          Delete account permanently?
        </h2>
        <p
          style={{
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
            margin: '0 0 20px',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          This will wipe your account and all associated data. It cannot be undone.
          Type <strong style={{ color: 'var(--sf-fg-1)', fontFamily: 'var(--sf-font-mono)' }}>DELETE</strong> to confirm.
        </p>
        <input
          type="text"
          placeholder="Type DELETE"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 12px',
            borderRadius: 'var(--sf-radius-md)',
            border: `1px solid ${canDelete ? 'var(--sf-error)' : 'var(--sf-border)'}`,
            background: 'var(--sf-bg-primary)',
            color: 'var(--sf-fg-1)',
            fontSize: 'var(--sf-text-sm)',
            fontFamily: 'var(--sf-font-mono)',
            outline: 'none',
            marginBottom: 20,
          }}
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={confirming}>
            Cancel
          </Button>
          <Button
            variant="error"
            onClick={onConfirm}
            disabled={!canDelete || confirming}
          >
            {confirming ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AccountSection({
  user,
  timezone,
}: {
  user: { name: string | null; email: string | null; image: string | null };
  timezone: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      router.push('/');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete account');
      setDeleting(false);
      setDialogOpen(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <SettingsPanel title="Account" desc="Your login info and profile.">
          <FieldRow label="Name">{user.name ?? '—'}</FieldRow>
          <FieldRow label="Email">{user.email ?? '—'}</FieldRow>
          <FieldRow label="Timezone">{timezone}</FieldRow>
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
                onClick={() => setDialogOpen(true)}
                style={{
                  minHeight: 40,
                  padding: '0 16px',
                  borderRadius: 'var(--sf-radius-md)',
                  background: 'var(--sf-error)',
                  color: 'var(--sf-fg-on-dark-1)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 500,
                  fontSize: 'var(--sf-text-sm)',
                  fontFamily: 'inherit',
                  letterSpacing: 'var(--sf-track-tight)',
                  transition: 'opacity var(--sf-dur-base) var(--sf-ease)',
                }}
              >
                Delete account
              </button>
            }
          />
        </DangerZone>
      </div>

      <DeleteAccountDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={() => void handleDelete()}
        confirming={deleting}
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Shared layout helpers
   ═══════════════════════════════════════════════════════════════════ */

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
        background: 'var(--sf-bg-secondary)',
        border: '1px solid var(--sf-error)',
        borderRadius: 'var(--sf-radius-lg)',
        padding: 28,
        boxShadow: 'var(--sf-shadow-card)',
      }}
    >
      <h2 className="sf-h3" style={{ margin: 0, color: 'var(--sf-error-ink)' }}>
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
   Billing — coming soon stub
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
              background: 'var(--sf-bg-dark)',
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
              background: 'var(--sf-bg-tertiary)',
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
              background: 'var(--sf-bg-tertiary)',
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
          You&apos;re on the free plan during beta. Paid plans will arrive after launch.
          All features are available now.
        </p>
      </SettingsPanel>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Integrations — X only; Reddit is always-on / no-binding
   ═══════════════════════════════════════════════════════════════════ */

function IntegrationsSection({
  channels,
}: {
  channels: Array<{ platform: string; username: string | null }>;
}) {
  const { toast } = useToast();
  const router = useRouter();

  const handleDisconnectX = async () => {
    try {
      const res = await fetch('/api/x/disconnect', { method: 'DELETE' });
      if (!res.ok) throw new Error('Disconnect failed');
      toast('X disconnected');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not disconnect');
    }
  };

  const handleConnectX = () => {
    window.location.href = '/api/x/connect';
  };

  const xChannel = channels.find((c) => c.platform === 'x');
  const xConnected = Boolean(xChannel);

  return (
    <SettingsPanel title="Integrations" desc="Connect the rails. Disconnect anytime.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <IntegrationRow
          name="X / Twitter"
          badge={
            xChannel?.username ? `@${xChannel.username} · OAuth` : 'Not connected'
          }
          icon={<XTileIcon />}
          action={
            xConnected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDisconnectX()}
              >
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnectX}>
                Connect
              </Button>
            )
          }
        />
      </div>
    </SettingsPanel>
  );
}

function IntegrationRow({
  name,
  badge,
  icon,
  action,
}: {
  name: string;
  badge: string;
  icon: ReactNode;
  action: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 14,
        borderRadius: 'var(--sf-radius-md)',
        background: 'var(--sf-bg-tertiary)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <IntegrationTile>{icon}</IntegrationTile>
        <div style={{ flex: 1, minWidth: 0 }}>
          <IntegrationName>{name}</IntegrationName>
          <IntegrationBadge>{badge}</IntegrationBadge>
        </div>
        {action}
      </div>
    </div>
  );
}

function IntegrationTile({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: 'var(--sf-bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--sf-border-subtle)',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function IntegrationName({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 'var(--sf-text-sm)',
        fontWeight: 600,
        color: 'var(--sf-fg-1)',
      }}
    >
      {children}
    </div>
  );
}

function IntegrationBadge({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--sf-fg-3)',
        marginTop: 2,
        fontFamily: 'var(--sf-font-mono)',
        letterSpacing: 'var(--sf-track-mono)',
      }}
    >
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Brand icons — tiny inline SVGs
   ═══════════════════════════════════════════════════════════════════ */

function XTileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-label="X">
      <rect
        width="24"
        height="24"
        rx="4"
        fill="currentColor"
        style={{ color: 'var(--sf-bg-dark)' }}
      />
      <path
        d="M16.8 5.5h2.3l-5 5.7L20 18.5h-4.6l-3.6-4.7-4.1 4.7H5.3l5.4-6.1L5 5.5h4.7l3.2 4.3 3.9-4.3z"
        fill="#fff"
      />
    </svg>
  );
}
