'use client';

/**
 * ShipFlare v3 — SubredditPicker
 *
 * Inline subreddit picker rendered in place of the Post button when a
 * Reddit `content_post` plan_item is missing its target subreddit.
 *
 * Data source: `GET /api/reddit-channels` (active rows only — disabled
 * channels are filtered client-side, matching the picker UX in the
 * onboarding card).
 *
 * Apply path: `PATCH /api/today/[id]/edit { params: { subreddit }}`,
 * which merges into `plan_items.params` server-side. On 200 the parent
 * revalidates the today feed via `onApplied()` — the picker then
 * disappears because `needsSubreddit` flips to false on the next render.
 *
 * Manual-add: the founder can type a subreddit not in the list (e.g. a
 * niche community the research pass missed). Same regex as the server
 * route (`/^[A-Za-z0-9_]{3,21}$/`) for parity.
 *
 * `TextAction` is passed in as a prop rather than imported, because it
 * currently lives co-located with PostCard. A future cleanup can extract
 * TextAction to its own utility once ReplyCard's duplicate is folded in.
 */

import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';

/** 3-21 chars, letters / digits / underscore. Mirrors the server regex
 *  in `/api/reddit-channels` and `/api/today/[id]/edit`. */
const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{3,21}$/;

/** Shape of a row returned by `GET /api/reddit-channels`. */
interface RedditChannelRow {
  id: string;
  subreddit: string;
  rank: number;
  fitScore: number | null;
  disabled: boolean;
  source: 'auto' | 'manual';
}

interface RedditChannelsResponse {
  channels: RedditChannelRow[];
}

const fetchChannels = async (url: string): Promise<RedditChannelsResponse> => {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`GET ${url} failed (${r.status})`);
  }
  return (await r.json()) as RedditChannelsResponse;
};

/**
 * Tiny ghost-button styled like ReplyCard's / PostCard's `TextAction`.
 * Injected as a prop so the picker doesn't have to import or duplicate
 * the inline-style implementation that currently lives in those cards.
 */
export type TextActionComponent = ComponentType<{
  children: React.ReactNode;
  onClick: () => void;
}>;

interface SubredditPickerProps {
  planItemId: string;
  onApplied: () => void;
  onSkip: () => void;
  /** Ghost text-button used for "+ add another" / "Pick from list" / "Skip". */
  TextAction: TextActionComponent;
}

export function SubredditPicker({
  planItemId,
  onApplied,
  onSkip,
  TextAction,
}: SubredditPickerProps) {
  const { data, error, isLoading } = useSWR<RedditChannelsResponse>(
    '/api/reddit-channels',
    fetchChannels,
  );
  const [showManual, setShowManual] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Focus management: when the founder toggles between the dropdown and
  // the manual-add input we move focus to the newly-mounted control so
  // keyboard users don't lose their place.
  const selectRef = useRef<HTMLSelectElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  // useMemo so the array identity is stable across renders when the
  // SWR data hasn't changed. Otherwise the default-select useEffect
  // below re-fires on every parent re-render (per
  // react-hooks/exhaustive-deps).
  const activeChannels = useMemo<RedditChannelRow[]>(
    () => data?.channels.filter((c) => !c.disabled) ?? [],
    [data],
  );

  // Default the dropdown to the rank-1 (or first) active channel once
  // data arrives. We only auto-default while the user hasn't picked
  // anything yet so a deliberate selection isn't overwritten by a
  // background SWR refresh.
  useEffect(() => {
    if (!selected && activeChannels.length > 0) {
      const sorted = [...activeChannels].sort((a, b) => a.rank - b.rank);
      setSelected(sorted[0].subreddit);
    }
  }, [activeChannels, selected]);

  // Move keyboard focus to whichever control just appeared. Guarded so
  // the initial mount doesn't steal focus from the surrounding card.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (showManual) {
      manualInputRef.current?.focus();
    } else {
      selectRef.current?.focus();
    }
  }, [showManual]);

  const manualLooksValid = SUBREDDIT_REGEX.test(manualValue.trim());
  const effectiveChoice = showManual ? manualValue.trim() : selected;
  const canApply =
    !submitting &&
    (showManual ? manualLooksValid : effectiveChoice.length > 0);

  const handleApply = async (): Promise<void> => {
    if (!canApply) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/today/${planItemId}/edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { subreddit: effectiveChoice } }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (typeof body.error === 'string') detail = body.error;
        } catch {
          // non-JSON; fall through to status text
        }
        setSubmitError(`Couldn't apply subreddit: ${detail}`);
        return;
      }
      onApplied();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? `Couldn't apply subreddit: ${err.message}`
          : "Couldn't apply subreddit",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <span
        role="status"
        aria-label="Loading communities"
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-xs)',
          color: 'var(--sf-fg-3)',
          letterSpacing: 'var(--sf-track-mono)',
          padding: '6px 10px',
        }}
      >
        Loading communities…
      </span>
    );
  }

  if (error) {
    return (
      <span
        role="alert"
        style={{
          fontSize: 'var(--sf-text-sm)',
          color: 'var(--sf-fg-2)',
          padding: '6px 10px',
        }}
      >
        Couldn&apos;t load communities — try refreshing.
      </span>
    );
  }

  return (
    <div
      data-testid="subreddit-picker"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            letterSpacing: 'var(--sf-track-mono)',
            textTransform: 'uppercase',
          }}
        >
          Post to
        </span>

        {!showManual ? (
          <select
            ref={selectRef}
            aria-label="Choose a subreddit"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={submitting || activeChannels.length === 0}
            style={{
              background: 'var(--sf-bg-tertiary)',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-sm)',
              padding: '6px 10px',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'inherit',
            }}
          >
            {activeChannels.length === 0 ? (
              <option value="">— no communities —</option>
            ) : null}
            {[...activeChannels]
              .sort((a, b) => a.rank - b.rank)
              .map((c) => (
                <option key={c.subreddit} value={c.subreddit}>
                  r/{c.subreddit}
                </option>
              ))}
          </select>
        ) : (
          <input
            ref={manualInputRef}
            aria-label="Add a subreddit"
            placeholder="e.g. SaaS"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            disabled={submitting}
            style={{
              background: 'var(--sf-bg-tertiary)',
              border: `1px solid ${
                manualValue.length > 0 && !manualLooksValid
                  ? 'var(--sf-danger)'
                  : 'var(--sf-border)'
              }`,
              borderRadius: 'var(--sf-radius-sm)',
              padding: '6px 10px',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'inherit',
              minWidth: 140,
            }}
          />
        )}

        <Button size="sm" onClick={handleApply} disabled={!canApply}>
          {submitting ? 'Applying…' : 'Apply'}
        </Button>

        <TextAction
          onClick={() => {
            setShowManual((v) => !v);
            setSubmitError(null);
          }}
        >
          {showManual ? 'Pick from list' : '+ add another'}
        </TextAction>

        <TextAction onClick={onSkip}>Skip</TextAction>
      </div>

      {showManual && manualValue.length > 0 && !manualLooksValid ? (
        <span
          role="alert"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-danger)',
            letterSpacing: 'var(--sf-track-normal)',
          }}
        >
          3-21 chars, letters / digits / underscore only.
        </span>
      ) : null}

      {submitError ? (
        <span
          role="alert"
          style={{
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-danger)',
            letterSpacing: 'var(--sf-track-normal)',
          }}
        >
          {submitError}
        </span>
      ) : null}
    </div>
  );
}
