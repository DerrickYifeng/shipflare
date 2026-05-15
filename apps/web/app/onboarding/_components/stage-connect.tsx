// Stage 4 — Connect. Only X uses OAuth; Reddit is a no-binding always-on
// channel (handoff-only dispatch + RedditClient.appOnly() reads), so no
// Connect step is required for it. State is derived from /api/channels —
// on the X callback the user lands back at /onboarding and the Redis
// draft resumes at this stage.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { OnbButton } from './_shared/onb-button';
import {
  AccountCard,
  type AccountCardState,
} from './_shared/account-card';
import { ArrowRight, X } from './icons';
import { COPY } from './_copy';

interface ChannelRow {
  id: string;
  platform: string;
  username: string;
}

interface StageConnectProps {
  onBack: () => void;
  onContinue: () => void;
}

interface PlatformState {
  state: AccountCardState;
  error: string | null;
}

const INITIAL: PlatformState = { state: 'idle', error: null };

export function StageConnect({ onBack, onContinue }: StageConnectProps) {
  const [xState, setXState] = useState<PlatformState>(INITIAL);

  const refreshChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) return;
      const body = (await res.json()) as { channels: ChannelRow[] };
      const xConn = body.channels.some((c) => c.platform === 'x');
      setXState({ state: xConn ? 'connected' : 'idle', error: null });
    } catch {
      /* best effort — fall through with idle card */
    }
  }, []);

  useEffect(() => {
    void refreshChannels();
  }, [refreshChannels]);

  const connectX = () => {
    setXState({ state: 'connecting', error: null });
    window.location.href = `/api/channels/x/connect?returnTo=${encodeURIComponent('/onboarding')}`;
  };

  const disconnectX = async () => {
    try {
      const res = await fetch('/api/channels/x/disconnect', { method: 'DELETE' });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      setXState({ state: 'idle', error: null });
    } catch (err) {
      setXState({
        state: 'error',
        error: err instanceof Error ? err.message : COPY.stage4.errorX,
      });
    }
  };

  const xConnected = xState.state === 'connected';

  return (
    <div>
      <StepHeader
        kicker={COPY.stage4.kicker}
        title={COPY.stage4.title}
        sub={COPY.stage4.sub}
      />

      <AccountCard
        state={xState.state}
        iconColor="#000"
        icon={<X />}
        title={COPY.stage4.cards.x.title}
        desc={COPY.stage4.cards.x.desc}
        sample={COPY.stage4.cards.x.sample}
        errorMessage={xState.error ?? COPY.stage4.errorX}
        onConnect={connectX}
        onDisconnect={() => void disconnectX()}
        onRetry={connectX}
      />

      <div
        style={{
          marginTop: 28,
          padding: '12px 14px',
          background: 'rgba(0,0,0,0.03)',
          borderRadius: 10,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--sf-accent)',
            marginTop: 8,
            flexShrink: 0,
          }}
        />
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-2)',
          }}
        >
          <strong style={{ color: 'var(--sf-fg-1)', fontWeight: 600 }}>
            {COPY.stage4.infoTitle}
          </strong>
          {COPY.stage4.infoDetail}
        </div>
      </div>

      <ActionBar
        back={
          <OnbButton size="lg" variant="ghost" onClick={onBack}>
            {COPY.stage4.backCta}
          </OnbButton>
        }
        extras={
          <OnbButton size="lg" variant="ghost" onClick={onContinue}>
            {COPY.stage4.skipCta}
          </OnbButton>
        }
        primary={
          <OnbButton
            size="lg"
            variant="primary"
            disabled={!xConnected}
            onClick={onContinue}
          >
            {COPY.stage4.nextCta}
            <ArrowRight size={14} />
          </OnbButton>
        }
      />
    </div>
  );
}
