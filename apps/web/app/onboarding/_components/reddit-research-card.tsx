'use client';

/**
 * <RedditResearchCard /> — surfaces the Reddit-channel research output
 * to the founder.
 *
 * Three render branches, all derived from `/api/reddit-channels` GET:
 *   - `error`:   SWR fetcher threw (e.g. 4xx/5xx). Shows a refresh hint.
 *   - `empty`:   no rows yet — research will run on next kickoff, or
 *                click Re-research to fire it now.
 *   - `done`:    list of subreddits (active first, then disabled) with
 *                fit / activity / source badges + add-manual + re-research.
 *
 * Kickoff runs research automatically (Task 11) so there is no dedicated
 * progress page anymore. Re-research from this card is fire-and-forget
 * from the UI's perspective — we surface a one-shot inline hint telling
 * the founder to refresh in 30–60s.
 *
 * Design tokens follow the project's `--sf-*` namespace (see
 * `src/app/globals.css`). No hex fallbacks — if a token is missing we
 * want the cascade to surface the gap, not silently mask it.
 */

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';

interface ChannelActivity {
  postsLast7d?: number;
  commentsLast7d?: number;
  medianUpvotes?: number;
}

type ChannelSource = 'auto' | 'manual';

interface ChannelRow {
  id: string;
  subreddit: string;
  memberCount: number | null;
  fitScore: number | null;
  rulesSummary: string | null;
  activity: ChannelActivity | null;
  rank: number;
  source: ChannelSource;
  disabled: boolean;
}

interface ChannelsResponse {
  channels: ChannelRow[];
}

const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{3,21}$/;

/**
 * Throws on non-2xx so SWR surfaces it via `error` instead of letting
 * the component parse a JSON error envelope into success data. SWR's
 * built-in revalidation will keep retrying once we've signalled an
 * error here.
 */
async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`${url} → ${r.status}`);
  }
  return (await r.json()) as T;
}

function formatMembers(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fitBadgeColor(score: number | null): string {
  if (score == null) return 'var(--sf-fg-3)';
  if (score >= 0.7) return 'var(--sf-success)';
  if (score >= 0.4) return 'var(--sf-warning)';
  return 'var(--sf-fg-3)';
}

interface ChannelRowProps {
  row: ChannelRow;
  onToggle: (subreddit: string, nextDisabled: boolean) => void;
  busy: boolean;
}

function ChannelRowView({ row, onToggle, busy }: ChannelRowProps) {
  const fit =
    row.fitScore == null ? '—' : `${Math.round(row.fitScore * 100)}%`;
  const posts = row.activity?.postsLast7d;
  const comments = row.activity?.commentsLast7d;
  const activityText =
    posts != null || comments != null
      ? `${posts ?? 0} posts · ${comments ?? 0} comments / 7d`
      : 'No activity stats';

  return (
    <li
      data-testid="reddit-channel-row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--sf-border)',
        background: row.disabled
          ? 'var(--sf-bg-tertiary)'
          : 'var(--sf-bg-secondary)',
        opacity: row.disabled ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: 'var(--sf-fg-1)',
            }}
          >
            r/{row.subreddit}
          </span>
          <span style={{ fontSize: 12, color: 'var(--sf-fg-3)' }}>
            {formatMembers(row.memberCount)} members
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-label={`fit score ${fit}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--sf-fg-on-dark-1)',
              background: fitBadgeColor(row.fitScore),
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            fit {fit}
          </span>
          <span
            aria-label={`source ${row.source}`}
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--sf-fg-3)',
              border: '1px solid var(--sf-border)',
              padding: '2px 8px',
              borderRadius: 999,
              textTransform: 'capitalize',
            }}
          >
            {row.source}
          </span>
          <button
            type="button"
            onClick={() => onToggle(row.subreddit, !row.disabled)}
            disabled={busy}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid var(--sf-border)',
              background: 'transparent',
              color: 'var(--sf-fg-1)',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {row.disabled ? 'Enable' : 'Disable'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--sf-fg-3)' }}>
        {activityText}
      </div>
      {row.rulesSummary ? (
        <div
          title={row.rulesSummary}
          style={{
            fontSize: 12,
            color: 'var(--sf-fg-4)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          Rules: {row.rulesSummary}
        </div>
      ) : null}
    </li>
  );
}

export function RedditResearchCard() {
  const [addError, setAddError] = useState<string | null>(null);
  const [addValue, setAddValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [reResearchError, setReResearchError] = useState<string | null>(null);
  const [reResearchHint, setReResearchHint] = useState<string | null>(null);

  const channels = useSWR<ChannelsResponse>(
    '/api/reddit-channels',
    fetcher,
    { revalidateOnFocus: false },
  );

  const sortedChannels = (channels.data?.channels ?? [])
    .slice()
    .sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      return a.rank - b.rank;
    });

  async function handleToggle(subreddit: string, nextDisabled: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/reddit-channels', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subreddit, disabled: nextDisabled }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      await channels.mutate();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddError(null);
    const trimmed = addValue.trim();
    if (!SUBREDDIT_REGEX.test(trimmed)) {
      setAddError(
        'Use 3–21 letters, numbers, or underscores (no r/ prefix).',
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/reddit-channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subreddit: trimmed }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      setAddValue('');
      await channels.mutate();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReResearch() {
    setReResearchError(null);
    setReResearchHint(null);
    setBusy(true);
    try {
      const r = await fetch('/api/reddit-channels/re-research', {
        method: 'POST',
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      // Fire-and-forget: the worker runs asynchronously. SWR's
      // revalidate-on-focus will pick up new rows once they land, or
      // the founder can manually refresh.
      setReResearchHint(
        'Research kicked off — refresh in 30–60s to see the results.',
      );
      await channels.mutate();
    } catch (err) {
      setReResearchError(
        err instanceof Error ? err.message : 'Failed to start re-research',
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Error (fetcher threw) ───────────────────────────────────────────────
  // Surfaces 4xx/5xx during the brief window between /api/onboarding/commit
  // and the first successful read, or any other transient failure. We trust
  // SWR to keep revalidating in the background.
  if (channels.error) {
    return (
      <section
        aria-labelledby="reddit-research-heading"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          borderRadius: 14,
          border: '1px solid var(--sf-border)',
          background: 'var(--sf-bg-secondary)',
        }}
      >
        <h2
          id="reddit-research-heading"
          style={{ fontSize: 18, margin: 0, color: 'var(--sf-fg-1)' }}
        >
          Unable to load Reddit communities
        </h2>
        <p style={{ margin: 0, color: 'var(--sf-fg-2)' }}>
          Refresh the page to retry. If this persists, your product
          record may still be initializing.
        </p>
      </section>
    );
  }

  // ── Loading (first paint, before SWR returns) ──────────────────────────
  if (channels.isLoading && !channels.data) {
    return (
      <section
        aria-labelledby="reddit-research-heading"
        aria-busy="true"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          borderRadius: 14,
          border: '1px solid var(--sf-border)',
          background: 'var(--sf-bg-secondary)',
        }}
      >
        <h2
          id="reddit-research-heading"
          style={{ fontSize: 18, margin: 0, color: 'var(--sf-fg-1)' }}
        >
          Your Reddit communities
        </h2>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: 'var(--sf-fg-2)',
          }}
        >
          <span
            role="status"
            aria-label="loading"
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '2px solid var(--sf-border)',
              borderTopColor: 'var(--sf-accent)',
              animation: 'spin 0.9s linear infinite',
              display: 'inline-block',
            }}
          />
          <span>Loading…</span>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </section>
    );
  }

  // ── Loaded (empty or with rows) ────────────────────────────────────────
  return (
    <section
      aria-labelledby="reddit-research-heading"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 24,
        borderRadius: 14,
        border: '1px solid var(--sf-border)',
        background: 'var(--sf-bg-secondary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <h2
          id="reddit-research-heading"
          style={{ fontSize: 18, margin: 0, color: 'var(--sf-fg-1)' }}
        >
          Your Reddit communities
        </h2>
        <button
          type="button"
          onClick={handleReResearch}
          disabled={busy}
          style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 8,
            border: '1px solid var(--sf-border)',
            background: 'transparent',
            color: 'var(--sf-fg-1)',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Re-research
        </button>
      </div>

      {reResearchError ? (
        <div
          role="alert"
          style={{ fontSize: 12, color: 'var(--sf-error-ink)' }}
        >
          {reResearchError}
        </div>
      ) : null}

      {reResearchHint ? (
        <div
          role="status"
          style={{ fontSize: 12, color: 'var(--sf-fg-2)' }}
        >
          {reResearchHint}
        </div>
      ) : null}

      {sortedChannels.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--sf-fg-2)' }}>
          No Reddit communities researched yet. The team will research
          them automatically on your next kickoff, or click Re-research
          to run it now.
        </p>
      ) : (
        <ul
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            listStyle: 'none',
            padding: 0,
            margin: 0,
          }}
        >
          {sortedChannels.map((row) => (
            <ChannelRowView
              key={row.id}
              row={row}
              onToggle={handleToggle}
              busy={busy}
            />
          ))}
        </ul>
      )}

      <form
        onSubmit={handleAdd}
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <label
          htmlFor="add-subreddit-input"
          style={{ fontSize: 13, fontWeight: 500, color: 'var(--sf-fg-1)' }}
        >
          Add another subreddit
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="add-subreddit-input"
            type="text"
            placeholder="e.g. SaaS"
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--sf-border)',
              background: 'var(--sf-bg-tertiary)',
              color: 'var(--sf-fg-1)',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={busy || addValue.trim().length === 0}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--sf-accent)',
              color: 'var(--sf-fg-on-dark-1)',
              cursor: busy ? 'wait' : 'pointer',
              fontWeight: 500,
            }}
          >
            Add
          </button>
        </div>
        {addError ? (
          <div
            role="alert"
            style={{ fontSize: 12, color: 'var(--sf-error-ink)' }}
          >
            {addError}
          </div>
        ) : null}
      </form>
    </section>
  );
}
