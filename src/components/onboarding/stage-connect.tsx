// Stage 4 — Connect. Reddit uses the handle-input handoff flow (no OAuth);
// X still uses OAuth. State is derived from /api/channels — on the X
// callback the user lands back at /onboarding and the Redis draft resumes
// at this stage.

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
import { RedditHandleInput } from './reddit-handle-input';

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

  const connectX = () => {
    setByPlatform((prev) => ({
      ...prev,
      x: { state: 'connecting', error: null },
    }));
    window.location.href = `/api/x/connect?returnTo=${encodeURIComponent('/onboarding')}`;
  };

  const submitRedditHandle = async (handle: string) => {
    setByPlatform((prev) => ({
      ...prev,
      reddit: { state: 'connecting', error: null },
    }));
    try {
      const res = await fetch('/api/reddit/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        const detail = body?.detail ?? body?.error ?? `Save failed (${res.status})`;
        setByPlatform((prev) => ({
          ...prev,
          reddit: { state: 'error', error: detail },
        }));
        throw new Error(detail);
      }
      await refreshChannels();
    } catch (err) {
      if (err instanceof Error) {
        setByPlatform((prev) => ({
          ...prev,
          reddit: { state: 'error', error: err.message },
        }));
        throw err;
      }
      const fallback = COPY.stage4.errorReddit;
      setByPlatform((prev) => ({
        ...prev,
        reddit: { state: 'error', error: fallback },
      }));
      throw new Error(fallback);
    }
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

      <RedditHandleInput onSubmit={submitRedditHandle} />
      {byPlatform.reddit.state === 'error' && byPlatform.reddit.error && (
        <p
          role="alert"
          style={{
            marginTop: 8,
            fontSize: 13,
            color: 'var(--sf-error, #d33)',
          }}
        >
          {byPlatform.reddit.error}
        </p>
      )}
      <div style={{ height: 12 }} />
      <AccountCard
        state={byPlatform.x.state}
        iconColor="#000"
        icon={<X />}
        title={COPY.stage4.cards.x.title}
        desc={COPY.stage4.cards.x.desc}
        sample={COPY.stage4.cards.x.sample}
        errorMessage={byPlatform.x.error ?? COPY.stage4.errorX}
        onConnect={connectX}
        onDisconnect={() => void disconnect('x')}
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
