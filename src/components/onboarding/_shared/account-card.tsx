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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
        <div style={{ flexShrink: 0 }}>
          {state === 'idle' && (
            <OnbButton variant="secondary" onClick={onConnect}>
              Connect
            </OnbButton>
          )}
          {state === 'connecting' && (
            <OnbButton variant="secondary" disabled>
              Connecting…
            </OnbButton>
          )}
          {state === 'connected' && (
            <OnbButton variant="ghost" onClick={onDisconnect}>
              Disconnect
            </OnbButton>
          )}
          {state === 'error' && (
            <OnbButton variant="secondary" onClick={onRetry}>
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
