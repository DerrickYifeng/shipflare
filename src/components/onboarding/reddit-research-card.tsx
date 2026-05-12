'use client';

/**
 * <RedditResearchCard /> — surfaces the kickoff Reddit-channel research
 * pass to the founder.
 *
 * Three states:
 *   - `pending`: spinner + reassurance copy. Polls every 3s.
 *   - `done`:    list of subreddits (active first, then disabled) with
 *                fit / activity / source badges + add-manual + re-research.
 *   - `failed`:  error state + retry CTA (re-research endpoint wires up
 *                in Task 8; for now the button is presented but the POST
 *                target is the same once /api/reddit-channels/re-research
 *                ships).
 *
 * SWR polls `/api/onboarding/reddit-research/status` and
 * `/api/reddit-channels`. The refreshInterval is gated on the current
 * status so once we settle on `done` or `failed` we stop hitting the
 * server.
 */

import { useState } from 'react';
import useSWR from 'swr';

interface ChannelRow {
  id: string;
  subreddit: string;
  memberCount: number | null;
  fitScore: number | null;
  rulesSummary: string | null;
  activity: {
    postsLast7d?: number;
    commentsLast7d?: number;
    medianUpvotes?: number;
  } | null;
  rank: number;
  source: 'auto' | 'manual' | string;
  disabled: boolean;
}

interface StatusResponse {
  status: 'pending' | 'done' | 'failed';
  count: number;
}

interface ChannelsResponse {
  channels: ChannelRow[];
}

const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{3,21}$/;

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function formatMembers(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fitBadgeColor(score: number | null): string {
  if (score == null) return 'var(--color-sf-text-tertiary, #888)';
  if (score >= 0.7) return 'var(--color-sf-success, #2a8a4a)';
  if (score >= 0.4) return 'var(--color-sf-warning, #b8830f)';
  return 'var(--color-sf-text-tertiary, #888)';
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--color-sf-border, #e3e3e3)',
        background: row.disabled
          ? 'var(--color-sf-bg-muted, #f6f6f6)'
          : 'var(--color-sf-bg-primary, #fff)',
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
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            r/{row.subreddit}
          </span>
          <span
            style={{ fontSize: 12, color: 'var(--color-sf-text-secondary, #555)' }}
          >
            {formatMembers(row.memberCount)} members
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-label={`fit score ${fit}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#fff',
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
              color: 'var(--color-sf-text-secondary, #555)',
              border: '1px solid var(--color-sf-border, #e3e3e3)',
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
              border: '1px solid var(--color-sf-border, #ccc)',
              background: 'transparent',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {row.disabled ? 'Enable' : 'Disable'}
          </button>
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--color-sf-text-secondary, #555)',
        }}
      >
        {activityText}
      </div>
      {row.rulesSummary ? (
        <div
          title={row.rulesSummary}
          style={{
            fontSize: 12,
            color: 'var(--color-sf-text-tertiary, #888)',
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

  const status = useSWR<StatusResponse>(
    '/api/onboarding/reddit-research/status',
    fetcher,
    {
      refreshInterval: (latest) => (latest?.status === 'pending' ? 3000 : 0),
    },
  );

  const channels = useSWR<ChannelsResponse>(
    '/api/reddit-channels',
    fetcher,
    {
      refreshInterval: () =>
        status.data?.status === 'pending' ? 3000 : 0,
    },
  );

  const sortedChannels = (channels.data?.channels ?? []).slice().sort((a, b) => {
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
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      await channels.mutate();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
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
        const detail = await res.json().catch(() => null);
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
    // Wired up in Task 8. For now we just refresh local state so the
    // founder isn't stuck.
    await Promise.all([status.mutate(), channels.mutate()]);
  }

  const currentStatus = status.data?.status ?? 'pending';

  // ── Pending ─────────────────────────────────────────────────────────────
  if (currentStatus === 'pending') {
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
          border: '1px solid var(--color-sf-border, #e3e3e3)',
          background: 'var(--color-sf-bg-primary, #fff)',
        }}
      >
        <h2 id="reddit-research-heading" style={{ fontSize: 18, margin: 0 }}>
          Researching your Reddit communities
        </h2>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: 'var(--color-sf-text-secondary, #555)',
          }}
        >
          <span
            role="status"
            aria-label="loading"
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '2px solid var(--color-sf-border, #ddd)',
              borderTopColor: 'var(--color-sf-accent, #2563eb)',
              animation: 'spin 0.9s linear infinite',
              display: 'inline-block',
            }}
          />
          <span>
            Looking for the three subreddits where your ICP is most likely
            to engage. Usually takes under 60 seconds.
          </span>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </section>
    );
  }

  // ── Failed ──────────────────────────────────────────────────────────────
  if (currentStatus === 'failed') {
    return (
      <section
        aria-labelledby="reddit-research-heading"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          borderRadius: 14,
          border: '1px solid var(--color-sf-error, #d34a4a)',
          background: 'var(--color-sf-bg-primary, #fff)',
        }}
      >
        <h2 id="reddit-research-heading" style={{ fontSize: 18, margin: 0 }}>
          Couldn&apos;t finish researching Reddit
        </h2>
        <p
          style={{
            margin: 0,
            color: 'var(--color-sf-text-secondary, #555)',
          }}
        >
          Something went wrong while picking subreddits. You can retry or
          add subreddits manually below — we&apos;ll keep both either way.
        </p>
        <button
          type="button"
          onClick={handleReResearch}
          style={{
            alignSelf: 'flex-start',
            padding: '8px 14px',
            borderRadius: 10,
            border: '1px solid var(--color-sf-border, #ccc)',
            background: 'var(--color-sf-bg-primary, #fff)',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </section>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────
  return (
    <section
      aria-labelledby="reddit-research-heading"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 24,
        borderRadius: 14,
        border: '1px solid var(--color-sf-border, #e3e3e3)',
        background: 'var(--color-sf-bg-primary, #fff)',
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
        <h2 id="reddit-research-heading" style={{ fontSize: 18, margin: 0 }}>
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
            border: '1px solid var(--color-sf-border, #ccc)',
            background: 'transparent',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Re-research
        </button>
      </div>

      {sortedChannels.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--color-sf-text-secondary, #555)',
          }}
        >
          No subreddits yet — add your first one below.
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
          style={{ fontSize: 13, fontWeight: 500 }}
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
              border: '1px solid var(--color-sf-border, #ccc)',
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
              background: 'var(--color-sf-accent, #2563eb)',
              color: '#fff',
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
            style={{
              fontSize: 12,
              color: 'var(--color-sf-error, #d34a4a)',
            }}
          >
            {addError}
          </div>
        ) : null}
      </form>
    </section>
  );
}
