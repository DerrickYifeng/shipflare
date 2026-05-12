'use client';

/**
 * ShipFlare v2 — PostCard (scheduled post approval)
 *
 * Pixel-perfect port of `design_handoff/source/app/today.jsx → PostCard`.
 * Less chrome than ReplyCard: no borrowed quote, time + type live in the
 * header, draft body dominates, single primary Schedule action.
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { PLATFORMS } from '@/lib/platform-config';
import type { TodoItem } from '@/hooks/use-today';
import { PlatformGlyph } from './platform-glyph';

interface PostCardProps {
  item: TodoItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  isActive?: boolean;
  forceEditing?: boolean;
  onEditDone?: () => void;
  /**
   * Called after an inline subreddit picker successfully patches the
   * plan_item. The parent should revalidate the today feed so the
   * picker disappears and the Post button takes its place. Optional —
   * non-Reddit cards never trigger it.
   */
  onSubredditApplied?: () => void;
}

function platformDisplay(platform: string): string {
  return PLATFORMS[platform]?.displayName ?? platform;
}

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


export function PostCard({
  item,
  onApprove,
  onSkip,
  onEdit,
  isActive = false,
  forceEditing = false,
  onEditDone,
  onSubredditApplied,
}: PostCardProps) {
  const [localEditing, setLocalEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.draftBody ?? '');
  const rootRef = useRef<HTMLElement>(null);

  const isEditing = localEditing || forceEditing;
  const activeBody = isEditing ? editBody : item.draftBody ?? '';
  const len = activeBody.length;

  useEffect(() => {
    if (isActive) {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  const isOptimistic = item.status !== 'pending';
  const contentType = item.calendarContentType ?? 'Original';

  // Reddit content_post safety net: legacy plan_items (or any future
  // bug in the subreddit-research pipeline) could land here without
  // `params.subreddit`. dispatchApprove would throw on POST in that
  // case; instead we swap the Post button for an inline subreddit
  // picker so the founder can choose one without leaving Today.
  const subredditOnItem = (item.params as { subreddit?: unknown } | null | undefined)?.subreddit;
  const needsSubreddit =
    item.platform === PLATFORMS.reddit.id &&
    item.calendarContentType === 'content_post' &&
    (typeof subredditOnItem !== 'string' || subredditOnItem.length === 0);

  const handleSaveEdit = () => {
    onEdit(item.id, editBody);
    setLocalEditing(false);
    onEditDone?.();
  };

  const handleCancelEdit = () => {
    setEditBody(item.draftBody ?? '');
    setLocalEditing(false);
    onEditDone?.();
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSaveEdit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const articleStyle: CSSProperties = {
    borderRadius: 'var(--sf-radius-lg)',
    background: 'var(--sf-bg-secondary)',
    boxShadow: isActive ? 'var(--sf-shadow-card-hover)' : 'var(--sf-shadow-card)',
    border: '1px solid var(--sf-border-subtle)',
    outline: isActive ? '2px solid var(--sf-accent)' : 'none',
    outlineOffset: isActive ? 2 : 0,
    overflow: 'hidden',
    opacity: isOptimistic ? 0.6 : 1,
    pointerEvents: isOptimistic ? 'none' : 'auto',
    transition: 'box-shadow var(--sf-dur-base) var(--sf-ease-swift)',
  };

  return (
    <article ref={rootRef} style={articleStyle} aria-busy={isOptimistic || undefined}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 18px',
          borderBottom: '1px solid var(--sf-border-subtle)',
        }}
      >
        <PlatformGlyph platform={item.platform} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 'var(--sf-text-sm)',
              fontWeight: 600,
              color: 'var(--sf-fg-1)',
            }}
          >
            {capitalize(contentType)} post
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-normal)',
              flexWrap: 'wrap',
            }}
          >
            <span
              className="sf-mono"
              style={{
                letterSpacing: 'var(--sf-track-mono)',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              Original · {platformDisplay(item.platform)}
            </span>
          </div>
        </div>
      </header>

      {/* Body — the star of the card */}
      <div style={{ padding: '18px 18px 12px' }}>
        {item.draftPostTitle && !isEditing ? (
          <p
            style={{
              margin: '0 0 8px',
              fontSize: 'var(--sf-text-base)',
              fontWeight: 500,
              color: 'var(--sf-fg-1)',
              letterSpacing: 'var(--sf-track-normal)',
            }}
          >
            {item.draftPostTitle}
          </p>
        ) : null}

        {!isEditing ? (
          <div
            className="sf-mono"
            style={{
              marginTop: 2,
              marginBottom: 8,
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-mono)',
            }}
          >
            Drafted by your writer
          </div>
        ) : null}

        {!isEditing && item.draftBody ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-base)',
              color: 'var(--sf-fg-1)',
              letterSpacing: 'var(--sf-track-normal)',
              lineHeight: 'var(--sf-lh-relaxed)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {item.draftBody}
          </p>
        ) : null}

        {!isEditing && !item.draftBody ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-3)',
              fontStyle: 'italic',
              letterSpacing: 'var(--sf-track-normal)',
            }}
          >
            {item.title} — draft pending
          </p>
        ) : null}

        {isEditing ? (
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            onKeyDown={handleEditKeyDown}
            rows={4}
            autoFocus
            style={{
              width: '100%',
              background: 'var(--sf-bg-tertiary)',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-md)',
              padding: 12,
              fontSize: 'var(--sf-text-base)',
              letterSpacing: 'var(--sf-track-normal)',
              color: 'var(--sf-fg-1)',
              lineHeight: 'var(--sf-lh-relaxed)',
              resize: 'vertical',
              minHeight: 96,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
        ) : null}
      </div>

      {/* Why it works */}
      {item.draftWhyItWorks && !isEditing ? (
        <div style={{ padding: '0 18px 8px' }}>
          <Toggle label="Why this works">
            <p
              style={{
                margin: 0,
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-2)',
                letterSpacing: 'var(--sf-track-normal)',
                lineHeight: 'var(--sf-lh-normal)',
              }}
            >
              {item.draftWhyItWorks}
            </p>
          </Toggle>
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '12px 18px',
          borderTop: '1px solid var(--sf-border-subtle)',
          background: 'var(--sf-bg-tertiary)',
        }}
      >
        {!isEditing ? (
          item.status === 'queued' ? (
            <span
              className="sf-mono"
              style={{
                fontSize: 'var(--sf-text-xs)',
                fontWeight: 600,
                color: 'var(--sf-success)',
                letterSpacing: 'var(--sf-track-mono)',
                textTransform: 'uppercase',
                padding: '6px 10px',
              }}
            >
              Posted ✓
            </span>
          ) : needsSubreddit ? (
            <SubredditPicker
              planItemId={item.id}
              onApplied={() => onSubredditApplied?.()}
              onSkip={() => onSkip(item.id)}
            />
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => onApprove(item.id)}
                disabled={item.status === 'pending_approval' || !item.draftBody}
              >
                {item.status === 'pending_approval' ? 'Posting…' : 'Post'}
              </Button>
              {item.draftBody ? (
                <TextAction onClick={() => setLocalEditing(true)}>Edit</TextAction>
              ) : null}
              <TextAction onClick={() => onSkip(item.id)}>Skip</TextAction>
            </>
          )
        ) : (
          <>
            <Button size="sm" onClick={handleSaveEdit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
              Cancel
            </Button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-4)',
            letterSpacing: 'var(--sf-track-mono)',
          }}
        >
          {len}
        </span>
      </div>
    </article>
  );
}

/* ── Utility: capitalize first letter (no lodash) ────────────────── */

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/* ── Subreddit picker (Reddit content_post safety net) ───────────────── */

const fetchChannels = async (url: string): Promise<RedditChannelsResponse> => {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`GET ${url} failed (${r.status})`);
  }
  return (await r.json()) as RedditChannelsResponse;
};

interface SubredditPickerProps {
  planItemId: string;
  onApplied: () => void;
  onSkip: () => void;
}

/**
 * Inline subreddit picker shown in place of the Post button when a
 * Reddit `content_post` plan_item is missing its target subreddit.
 *
 * Data source: `GET /api/reddit-channels` (active rows only — disabled
 * channels are filtered client-side, matching the picker UX in the
 * onboarding card).
 *
 * Apply path: `PATCH /api/today/[id]/edit` with `{ params: { subreddit }}`
 * which merges into `plan_items.params` server-side. On 200 the parent
 * revalidates the today feed via `onApplied()` — the picker then
 * disappears because `needsSubreddit` flips to false on the next render.
 *
 * Manual-add: the founder can type a subreddit not in the list (e.g. a
 * niche community the research pass missed). Same regex as the server
 * route (`/^[A-Za-z0-9_]{3,21}$/`) for parity.
 */
function SubredditPicker({
  planItemId,
  onApplied,
  onSkip,
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

  const manualLooksValid = SUBREDDIT_REGEX.test(manualValue.trim());
  const effectiveChoice = showManual ? manualValue.trim() : selected;
  const canApply =
    !submitting &&
    (showManual ? manualLooksValid : effectiveChoice.length > 0);

  const handleApply = async () => {
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        // Reset child default margins so the row sits flush with the
        // surrounding action bar even when wrapped.
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

/* ── TextAction mirrors the ReplyCard one (kept local to avoid cycle) ── */

function TextAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'var(--sf-bg-secondary)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '6px 10px',
        fontFamily: 'inherit',
        fontSize: 'var(--sf-text-sm)',
        color: 'var(--sf-fg-2)',
        letterSpacing: 'var(--sf-track-normal)',
        borderRadius: 'var(--sf-radius-sm)',
        transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      {children}
    </button>
  );
}
