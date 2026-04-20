// Stage 4 — Connect. Two OAuth cards (Reddit + X) whose state is derived
// from /api/channels. Clicking Connect redirects to the existing OAuth
// routes — on callback the user lands back at /onboarding and the Redis
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
import { ArrowRight, Reddit, X } from './icons';
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

type Platform = 'reddit' | 'x';

interface PlatformState {
  state: AccountCardState;
  error: string | null;
}

const INITIAL: Record<Platform, PlatformState> = {
  reddit: { state: 'idle', error: null },
  x: { state: 'idle', error: null },
};

export function StageConnect({ onBack, onContinue }: StageConnectProps) {
  const [byPlatform, setByPlatform] =
    useState<Record<Platform, PlatformState>>(INITIAL);

  const refreshChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) return;
      const body = (await res.json()) as { channels: ChannelRow[] };
      setByPlatform((prev) => {
        const next = { ...prev };
        const redditConn = body.channels.some((c) => c.platform === 'reddit');
        const xConn = body.channels.some((c) => c.platform === 'x');
        next.reddit = {
          state: redditConn ? 'connected' : 'idle',
          error: null,
        };
        next.x = { state: xConn ? 'connected' : 'idle', error: null };
        return next;
      });
    } catch {
      /* best effort — fall through with idle cards */
    }
  }, []);

  useEffect(() => {
    void refreshChannels();
  }, [refreshChannels]);

  const connect = (platform: Platform) => {
    setByPlatform((prev) => ({
      ...prev,
      [platform]: { state: 'connecting', error: null },
    }));
    // Redirect to the existing OAuth initiator route; the callback will
    // write the channels row and redirect back.
    window.location.href = `/api/${platform}/connect`;
  };

  const disconnect = async (platform: Platform) => {
    try {
      const res = await fetch(`/api/${platform}/disconnect`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      setByPlatform((prev) => ({
        ...prev,
        [platform]: { state: 'idle', error: null },
      }));
    } catch (err) {
      setByPlatform((prev) => ({
        ...prev,
        [platform]: {
          state: 'error',
          error:
            err instanceof Error
              ? err.message
              : platform === 'reddit'
                ? COPY.stage4.errorReddit
                : COPY.stage4.errorX,
        },
      }));
    }
  };

  const anyConnected =
    byPlatform.reddit.state === 'connected' ||
    byPlatform.x.state === 'connected';

  return (
    <div>
      <StepHeader
        kicker={COPY.stage4.kicker}
        title={COPY.stage4.title}
        sub={COPY.stage4.sub}
      />

      <AccountCard
        state={byPlatform.reddit.state}
        iconColor="#ff4500"
        icon={<Reddit />}
        title={COPY.stage4.cards.reddit.title}
        desc={COPY.stage4.cards.reddit.desc}
        sample={COPY.stage4.cards.reddit.sample}
        errorMessage={byPlatform.reddit.error ?? COPY.stage4.errorReddit}
        onConnect={() => connect('reddit')}
        onDisconnect={() => void disconnect('reddit')}
        onRetry={() => connect('reddit')}
      />
      <div style={{ height: 12 }} />
      <AccountCard
        state={byPlatform.x.state}
        iconColor="#000"
        icon={<X />}
        title={COPY.stage4.cards.x.title}
        desc={COPY.stage4.cards.x.desc}
        sample={COPY.stage4.cards.x.sample}
        errorMessage={byPlatform.x.error ?? COPY.stage4.errorX}
        onConnect={() => connect('x')}
        onDisconnect={() => void disconnect('x')}
        onRetry={() => connect('x')}
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
            disabled={!anyConnected}
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
