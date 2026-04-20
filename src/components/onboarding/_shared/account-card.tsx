// AccountCard — Reddit/X OAuth connection card for Stage 4. Left-border
// color conveys connection state; a right-side action button switches label
// based on state.

import type { ReactNode } from 'react';
import { OnbButton } from './onb-button';
import { StatePill } from './state-pill';
import { OnbMono } from './onb-mono';

export type AccountCardState = 'idle' | 'connecting' | 'connected' | 'error';

interface AccountCardProps {
  state: AccountCardState;
  iconColor: string;
  icon: ReactNode;
  title: string;
  desc: string;
  /** Mono tail shown under the title when `state === 'connected'`. */
  sample: string;
  errorMessage?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
  /**
   * When `true`, the card shows a "Coming soon" pill next to the title,
   * the Connect button is disabled + dimmed, and hovering the button
   * shows the tooltip. OAuth state is still read (so a user who pre-connected
   * in Settings still sees connected state) but the card can't drive a
   * connect action. Per v3 gap audit finding #13 for Reddit.
   */
  comingSoon?: boolean;
  comingSoonLabel?: string;
  comingSoonTooltip?: string;
}

export function AccountCard({
  state,
  iconColor,
  icon,
  title,
  desc,
  sample,
  errorMessage,
  onConnect,
  onDisconnect,
  onRetry,
  comingSoon = false,
  comingSoonLabel = 'Coming soon',
  comingSoonTooltip = 'Coming soon',
}: AccountCardProps) {
  const leftBorder =
    state === 'connected'
      ? 'var(--sf-success)'
      : state === 'error'
        ? 'var(--sf-error)'
        : 'transparent';

  return (
    <section
      style={{
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        padding: '18px 20px',
        boxShadow: 'var(--sf-shadow-card)',
        borderLeft: `4px solid ${leftBorder}`,
        transition: 'border-color 300ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            background: `${iconColor}14`,
            color: iconColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 17,
                fontWeight: 600,
                letterSpacing: '-0.224px',
                color: 'var(--sf-fg-1)',
              }}
            >
              {title}
            </span>
            <Pill state={state} />
            {comingSoon && (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--sf-radius-sm, 5px)',
                  background: 'var(--sf-warning-light)',
                  color: 'var(--sf-warning-ink)',
                  fontSize: 10,
                  fontFamily: 'var(--sf-font-mono)',
                  letterSpacing: '-0.08px',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                }}
              >
                {comingSoonLabel}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--sf-fg-3)',
              letterSpacing: '-0.16px',
              marginTop: 2,
            }}
          >
            {desc}
          </div>
        </div>
        <div
          style={{ flexShrink: 0 }}
          title={comingSoon ? comingSoonTooltip : undefined}
        >
          {state === 'idle' && (
            <OnbButton
              variant="secondary"
              onClick={onConnect}
              disabled={comingSoon}
            >
              Connect
            </OnbButton>
          )}
          {state === 'connecting' && (
            <OnbButton variant="secondary" disabled>
              Connecting…
            </OnbButton>
          )}
          {state === 'connected' && (
            <OnbButton
              variant="ghost"
              onClick={onDisconnect}
              disabled={comingSoon}
            >
              Disconnect
            </OnbButton>
          )}
          {state === 'error' && (
            <OnbButton
              variant="secondary"
              onClick={onRetry}
              disabled={comingSoon}
            >
              Retry
            </OnbButton>
          )}
        </div>
      </div>
      {state === 'connected' && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid rgba(0,0,0,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <OnbMono>Scanning</OnbMono>
          <span
            style={{
              fontFamily: 'var(--sf-font-mono)',
              fontSize: 12,
              color: 'var(--sf-fg-1)',
              letterSpacing: '-0.12px',
            }}
          >
            {sample}
          </span>
        </div>
      )}
      {state === 'error' && errorMessage && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid rgba(0,0,0,0.06)',
            fontSize: 13,
            color: 'var(--sf-error-ink)',
            letterSpacing: '-0.16px',
          }}
        >
          {errorMessage}
        </div>
      )}
    </section>
  );
}

function Pill({ state }: { state: AccountCardState }) {
  if (state === 'connected') {
    return (
      <StatePill color="var(--sf-success-ink)" background="var(--sf-success-light)">
        ● Connected
      </StatePill>
    );
  }
  if (state === 'connecting') {
    return (
      <StatePill color="var(--sf-link)" background="var(--sf-accent-light)">
        ○ Connecting
      </StatePill>
    );
  }
  if (state === 'error') {
    return (
      <StatePill color="var(--sf-error-ink)" background="var(--sf-error-light)">
        ● Error
      </StatePill>
    );
  }
  return null;
}
