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
  useRef,
  useState,
} from 'react';
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
}

function platformDisplay(platform: string): string {
  return PLATFORMS[platform]?.displayName ?? platform;
}

function formatScheduledTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function PostCard({
  item,
  onApprove,
  onSkip,
  onEdit,
  isActive = false,
  forceEditing = false,
  onEditDone,
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
  const scheduledAt = formatScheduledTime(item.calendarScheduledAt);
  const contentType = item.calendarContentType ?? 'Original';

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
      {/* Header: glyph + type + scheduled pill */}
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
        {scheduledAt ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 'var(--sf-radius-pill)',
              fontSize: 'var(--sf-text-xs)',
              fontWeight: 600,
              fontFamily: 'var(--sf-font-mono)',
              letterSpacing: 'var(--sf-track-mono)',
              background: 'var(--sf-accent-light)',
              color: 'var(--sf-link)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <ClockGlyph />
            {scheduledAt}
          </span>
        ) : null}
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
            {item.scheduledFor
              ? ` · scheduled ${formatLocalTime(item.scheduledFor)}`
              : ''}
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

      {/* Footer: counter + actions */}
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
        {!isEditing ? (() => {
          // Three render modes by lifecycle:
          //   X handoff     — has xIntentUrl: open X compose pre-filled.
          //   X intent     — open X compose pre-filled; approve records handoff.
          //   Queued (API) — server queued via BullMQ; show "Queued" label.
          //   Default      — pre-click; show "Schedule" / "Approve".
          const isInFlight = item.status === 'pending_approval';

          if (item.xIntentUrl) {
            const intentUrl = item.xIntentUrl;
            const handleClick = () => {
              if (typeof window !== 'undefined') {
                window.open(intentUrl, '_blank', 'noopener,noreferrer');
              }
              onApprove(item.id);
            };
            return (
              <>
                <Button
                  size="sm"
                  disabled={!item.draftBody}
                  onClick={handleClick}
                >
                  Schedule
                </Button>
                {item.draftBody ? (
                  <TextAction onClick={() => setLocalEditing(true)}>Edit</TextAction>
                ) : null}
                <TextAction onClick={() => onSkip(item.id)}>Skip</TextAction>
              </>
            );
          }

          if (item.status === 'queued') {
            return (
              <>
                <span
                  className="sf-mono"
                  style={{
                    fontSize: 'var(--sf-text-xs)',
                    color: 'var(--sf-fg-3)',
                    letterSpacing: 'var(--sf-track-mono)',
                  }}
                >
                  Queued
                </span>
                <TextAction onClick={() => onSkip(item.id)}>Skip</TextAction>
              </>
            );
          }

          return (
            <>
              <Button
                size="sm"
                onClick={() => onApprove(item.id)}
                disabled={isInFlight}
              >
                {isInFlight
                  ? 'Scheduling…'
                  : item.draftBody
                  ? 'Schedule'
                  : 'Approve'}
              </Button>
              {item.draftBody ? (
                <TextAction onClick={() => setLocalEditing(true)}>Edit</TextAction>
              ) : null}
              <TextAction onClick={() => onSkip(item.id)}>Skip</TextAction>
            </>
          );
        })() : (
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

/* ── Clock glyph ──────────────────────────────────────────────────── */

function ClockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M6 3.5V6l1.5 1.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
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
