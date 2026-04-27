'use client';

/**
 * ShipFlare v2 — ReplyCard (boss/employee approval inbox)
 *
 * The agents drafted this reply; the user approves, edits, or skips.
 * Pixel-perfect port of `design_handoff/source/app/today.jsx → ReplyCard`.
 * State machine per INTERACTIONS.md §6:
 *
 *   pending ─approve─▶ posting ─(5s)─▶ posted
 *       │                 │
 *       │                 └─undo─▶ pending
 *       ├─skip─▶ skipped
 *       └─edit─▶ pending (draftBody updated)
 *
 * The 5s undo window is owned by the parent (via Toast action). This
 * component just fires callbacks.
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { Toggle } from '@/components/ui/toggle';
import { getPlatformCharLimits, PLATFORMS } from '@/lib/platform-config';
import type { TodoItem } from '@/hooks/use-today';
import { PlatformGlyph } from './platform-glyph';

interface ReplyCardProps {
  item: TodoItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  isActive?: boolean;
  forceEditing?: boolean;
  onEditDone?: () => void;
}

function getReplyCap(platform: string): number {
  return PLATFORMS[platform]
    ? getPlatformCharLimits(platform, 'reply')
    : 10_000;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * xAI Grok's `x_search` tool does not return tweet timestamps, and the
 * discovery agent used to hallucinate `2021-01-01T00:00:00Z` to fill the
 * schema. Treat that exact sentinel as "no real posted_at" so we fall back
 * to `discoveredAt` instead of showing "1935d".
 */
const HALLUCINATED_POSTED_AT = '2021-01-01T00:00:00.000Z';

/* ── Engagement helpers ─────────────────────────────────────────────── */

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function EngagementBadge({
  likes,
  reposts,
  replies,
  views,
}: {
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  views: number | null;
}) {
  const parts: string[] = [];
  if (likes != null) parts.push(`${formatCount(likes)} likes`);
  if (reposts != null) parts.push(`${formatCount(reposts)} reposts`);
  if (replies != null) parts.push(`${formatCount(replies)} replies`);
  if (views != null) parts.push(`${formatCount(views)} views`);
  if (parts.length === 0) return null;
  return (
    <div
      style={{
        fontFamily: 'var(--sf-font-mono)',
        fontSize: 11,
        color: 'var(--sf-fg-3)',
        letterSpacing: 'var(--sf-track-mono)',
        marginTop: 6,
      }}
    >
      {parts.join(' · ')}
    </div>
  );
}

function ReposterChips({ handles }: { handles: string[] | null }) {
  if (!handles || handles.length === 0) return null;
  const visible = handles.slice(0, 3);
  const overflow = handles.length - visible.length;
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
        marginTop: 6,
        fontSize: 11,
        color: 'var(--sf-fg-3)',
        alignItems: 'center',
      }}
    >
      <span>Reposted by</span>
      {visible.map((h) => (
        <span
          key={h}
          style={{
            padding: '1px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.04)',
            color: 'var(--sf-fg-2)',
          }}
        >
          @{h.replace(/^@/, '')}
        </span>
      ))}
      {overflow > 0 ? <span>+{overflow} more</span> : null}
    </div>
  );
}

/**
 * Platform-native primary identifier for the header.
 *   Reddit → `r/{community}` (the subreddit — what matters most on Reddit)
 *   X      → `@{author}` (X has no community concept; the author IS the handle)
 * Returns `null` when neither is available so the caller can skip rendering.
 */
function primaryIdentifier(
  platform: string,
  community: string | null | undefined,
  author: string | null | undefined,
): string | null {
  if (platform === 'x') {
    if (!author) return null;
    return author.startsWith('@') ? author : `@${author}`;
  }
  return community || null;
}

/**
 * Secondary line beneath the primary identifier.
 *   Reddit → `u/{author}` (the poster; secondary to the subreddit)
 *   X      → null (author already shown as primary)
 */
function secondaryIdentifier(
  platform: string,
  author: string | null | undefined,
): string | null {
  if (platform === 'reddit' && author) {
    return author.startsWith('u/') ? author : `u/${author}`;
  }
  return null;
}

function threadTimestamp(
  postedAt: string | null,
  discoveredAt: string | null,
): { label: string | null; prefix: string } {
  if (postedAt && postedAt !== HALLUCINATED_POSTED_AT) {
    return { label: relativeTime(postedAt), prefix: '' };
  }
  return { label: relativeTime(discoveredAt), prefix: 'discovered ' };
}

export function ReplyCard({
  item,
  onApprove,
  onSkip,
  onEdit,
  isActive = false,
  forceEditing = false,
  onEditDone,
}: ReplyCardProps) {
  const [localEditing, setLocalEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.draftBody ?? '');
  const rootRef = useRef<HTMLElement>(null);

  const isEditing = localEditing || forceEditing;
  const cap = getReplyCap(item.platform);
  const activeBody = isEditing ? editBody : item.draftBody ?? '';
  const len = activeBody.length;
  const over = len > cap;
  const conf = item.confidence != null ? Math.round(item.confidence * 100) : null;
  const confTone: 'success' | 'accent' | 'default' =
    conf == null ? 'default' : conf >= 80 ? 'success' : conf >= 65 ? 'accent' : 'default';

  useEffect(() => {
    if (isActive) {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  const isOptimistic = item.status !== 'pending';
  // `posting` = the 5s undo window after approval. Matches INTERACTIONS.md §6
  // (pending → posting → posted). The parent toast keeps a 5000ms timer; we
  // mirror that here with a visible countdown bar so the affordance doesn't
  // live solely in the toast.
  const isPosting = item.status === 'pending_approval';
  const { label: postedLabel, prefix: postedPrefix } = threadTimestamp(
    item.threadPostedAt,
    item.threadDiscoveredAt,
  );
  const primary = primaryIdentifier(
    item.platform,
    item.community,
    item.threadAuthor,
  );
  const secondary = secondaryIdentifier(item.platform, item.threadAuthor);

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
    // Default entry animation — every ReplyCard slides up on mount, not
    // only freshly-scanned ones. Matches prototype today.jsx:204-215.
    // NewCardReveal composes cleanly on top: its stagger delay determines
    // when this element first renders; this animation is the gentle
    // final arrival beat. Compositor-friendly: translate + opacity only.
    animation: 'sf-slide-up var(--sf-dur-slow) var(--sf-ease-swift)',
    transition: 'box-shadow var(--sf-dur-base) var(--sf-ease-swift), opacity var(--sf-dur-base) var(--sf-ease-swift)',
    opacity: isOptimistic ? 0.6 : 1,
    pointerEvents: isOptimistic ? 'none' : 'auto',
    position: 'relative',
  };

  return (
    <article ref={rootRef} style={articleStyle} aria-busy={isOptimistic || undefined}>
      {isPosting ? <PostingProgressBar durationMs={5_000} /> : null}
      {/* Header: platform-native primary identifier + score · right-aligned badges */}
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
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {primary && (
              <span
                style={{
                  fontSize: 'var(--sf-text-sm)',
                  fontWeight: 600,
                  color: 'var(--sf-fg-1)',
                  letterSpacing: 'var(--sf-track-tight)',
                }}
              >
                {primary}
              </span>
            )}
            {item.threadUpvotes != null && (
              <span
                className="sf-mono"
                style={{
                  fontSize: 'var(--sf-text-xs)',
                  color: 'var(--sf-fg-3)',
                  letterSpacing: 'var(--sf-track-mono)',
                  whiteSpace: 'nowrap',
                }}
              >
                ↑ {item.threadUpvotes}
              </span>
            )}
          </div>
          {(secondary || postedLabel) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 2,
                fontSize: 'var(--sf-text-xs)',
                color: 'var(--sf-fg-3)',
                letterSpacing: 'var(--sf-track-normal)',
              }}
            >
              {secondary && <span>{secondary}</span>}
              {secondary && postedLabel && <Dot />}
              {postedLabel && (
                <span style={{ whiteSpace: 'nowrap' }}>
                  {postedPrefix}
                  {postedLabel}
                </span>
              )}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <PriorityTag priority={item.priority} />
          {conf != null && (
            <Badge variant={confTone} mono>
              {conf}%
            </Badge>
          )}
        </div>
      </header>

      {/* Original content — hover-liftable, click opens threadUrl in new tab */}
      {item.threadBody ? (
        <ThreadContentLink href={item.threadUrl}>
          <blockquote
            style={{
              margin: 0,
              padding: '0 0 0 14px',
              borderLeft: '2px solid var(--sf-border)',
              fontSize: 'var(--sf-text-sm)',
              lineHeight: 'var(--sf-lh-normal)',
              color: 'var(--sf-fg-2)',
              letterSpacing: 'var(--sf-track-normal)',
              fontStyle: 'normal',
            }}
          >
            {item.threadBody}
          </blockquote>
          <EngagementBadge
            likes={item.threadLikesCount}
            reposts={item.threadRepostsCount}
            replies={item.threadRepliesCount}
            views={item.threadViewsCount}
          />
          <ReposterChips handles={item.threadSurfacedVia} />
          {/* Exposure / engagement row — sits inside the clickable block
              so "comments" and "discovered time" share the same nav affordance
              (click anywhere on this zone → open original post). */}
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-normal)',
              flexWrap: 'wrap',
            }}
          >
            {item.threadCommentCount != null && (
              <span style={{ whiteSpace: 'nowrap' }}>
                💬 {item.threadCommentCount}
                {item.platform === 'x' ? ' replies' : ' comments'}
              </span>
            )}
            {item.threadCommentCount != null && postedLabel && <Dot />}
            {postedLabel && (
              <span style={{ whiteSpace: 'nowrap' }}>
                {postedPrefix}
                {postedLabel}
              </span>
            )}
          </div>
        </ThreadContentLink>
      ) : null}

      {/* Draft reply area */}
      <div style={{ padding: '18px 18px 6px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <Ops>Your draft reply</Ops>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {over ? (
              <span
                style={{
                  fontSize: 'var(--sf-text-xs)',
                  color: 'var(--sf-error)',
                  fontWeight: 500,
                }}
              >
                Too long — edit to shorten
              </span>
            ) : null}
            <span
              className="sf-mono"
              style={{
                fontSize: 'var(--sf-text-xs)',
                color: over ? 'var(--sf-error)' : 'var(--sf-fg-4)',
                letterSpacing: 'var(--sf-track-mono)',
              }}
            >
              {len}
              {cap < 10_000 ? ` / ${cap}` : ''}
            </span>
          </div>
        </div>

        {!isEditing && item.draftBody ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-base)',
              color: 'var(--sf-fg-1)',
              lineHeight: 'var(--sf-lh-relaxed)',
              letterSpacing: 'var(--sf-track-normal)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {item.draftBody}
          </p>
        ) : null}

        {isEditing ? (
          <>
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
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button size="sm" onClick={handleSaveEdit}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {/* Why this works — subtle toggle */}
      {!isEditing && item.draftWhyItWorks ? (
        <div style={{ padding: '12px 18px 4px' }}>
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

      {/* Actions */}
      {!isEditing ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '14px 18px',
            borderTop: '1px solid var(--sf-border-subtle)',
            marginTop: 10,
            background: 'var(--sf-bg-tertiary)',
          }}
        >
          <Button
            size="sm"
            onClick={() => onApprove(item.id)}
            disabled={over || !item.draftBody}
            title={
              over
                ? `Reply is ${len - cap} chars over the ${cap} cap`
                : undefined
            }
          >
            Send reply
          </Button>
          <TextAction onClick={() => setLocalEditing(true)}>Edit</TextAction>
          <TextAction onClick={() => onSkip(item.id)}>Skip</TextAction>
        </div>
      ) : null}
    </article>
  );
}

/* ── Dot separator ─────────────────────────────────────────────────── */

function Dot() {
  return <span style={{ color: 'var(--sf-fg-4)' }}>·</span>;
}

/* ── Thread content link ───────────────────────────────────────────── */

/**
 * Wraps the original-thread blockquote + metrics in a hover-liftable
 * anchor pointing at the source post (threadUrl). Click anywhere inside
 * opens the tweet / Reddit post in a new tab. Compositor-friendly hover:
 * translateY + shadow, both driven by --sf-ease-swift.
 *
 * Falls back to a non-interactive `<div>` when `href` is missing so the
 * card doesn't claim an affordance it can't honour.
 */
function ThreadContentLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const sharedStyle: CSSProperties = {
    display: 'block',
    margin: '14px 18px 0 18px',
    padding: '10px 14px 12px 14px',
    borderRadius: 'var(--sf-radius-md)',
    background: 'transparent',
    textDecoration: 'none',
    color: 'inherit',
    transition:
      'transform var(--sf-dur-base) var(--sf-ease-swift), box-shadow var(--sf-dur-base) var(--sf-ease-swift), background var(--sf-dur-base) var(--sf-ease-swift)',
  };

  if (!href) {
    return <div style={sharedStyle}>{children}</div>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open original post"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...sharedStyle,
        cursor: 'pointer',
        background: hover ? 'var(--sf-bg-tertiary)' : 'transparent',
        boxShadow: hover ? 'var(--sf-shadow-card-hover)' : 'none',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
      }}
    >
      {children}
    </a>
  );
}

/* ── Priority tag ──────────────────────────────────────────────────── */

function PriorityTag({ priority }: { priority: string }) {
  if (priority !== 'time_sensitive') return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 7px',
        borderRadius: 'var(--sf-radius-pill)',
        fontSize: 'var(--sf-text-xs)',
        fontWeight: 600,
        letterSpacing: 'var(--sf-track-mono)',
        fontFamily: 'var(--sf-font-mono)',
        background: 'var(--sf-error-light)',
        color: 'var(--sf-error-ink)',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--sf-error)',
          animation: 'sf-pulse 1.4s ease-in-out infinite',
        }}
      />
      Time-sensitive
    </span>
  );
}

/* ── Text-link action (Edit / Skip) ────────────────────────────────── */

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

/* ── Posting progress bar ──────────────────────────────────────────── */

interface PostingProgressBarProps {
  durationMs: number;
}

/**
 * 5s undo-window visual. INTERACTIONS.md §6 state machine runs
 * `pending → posting → posted`; this bar lives above the card header
 * while the todo is in `posting`. If the parent undoes the approval the
 * card's status flips back to `'pending'`, this component unmounts, and
 * the bar goes away. No transform — just a 0→100% width tween in
 * compositor-friendly `transform: scaleX` against `transform-origin: left`.
 */
function PostingProgressBar({ durationMs }: PostingProgressBarProps) {
  // Trigger animation on mount. We rely on a single paint where scale starts
  // at 0 then transitions to 1 over durationMs.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    // Next frame kicks the transition.
    const raf = requestAnimationFrame(() => setFilled(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        overflow: 'hidden',
        background: 'var(--sf-border-subtle)',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: '100%',
          width: '100%',
          background: 'var(--sf-accent)',
          transform: filled ? 'scaleX(1)' : 'scaleX(0)',
          transformOrigin: 'left center',
          transition: `transform ${durationMs}ms linear`,
        }}
      />
    </div>
  );
}
