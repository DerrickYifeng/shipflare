'use client';

import type { CSSProperties } from 'react';
import {
  formatUpdatedAt,
  displayTitle,
  type ConversationMeta,
} from './conversation-meta';

export interface SessionRowProps {
  conversation: ConversationMeta;
  active: boolean;
  onSelect: (conversationId: string) => void;
}

/**
 * Sidebar entry for a single conversation thread. ChatGPT-style — no
 * status badges, no run indicators, just title + relative time. Any
 * conversation can be clicked and resumed at any moment; the UI no
 * longer treats "running" as an interaction-gating state.
 */
export function SessionRow({ conversation, active, onSelect }: SessionRowProps) {
  const title = displayTitle(conversation);
  const untitled = !conversation.title;

  const wrap: CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    width: '100%',
    display: 'block',
    padding: '10px 12px',
    minHeight: 52,
    // Flex siblings in SessionList's scroll container shrink to fit
    // by default — kill that so the row's content height wins.
    flexShrink: 0,
    border: 0,
    background: active ? 'var(--sf-bg-secondary)' : 'transparent',
    borderRadius: 8,
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--sf-fg-1)',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.3,
  };

  const titleStyle: CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: untitled ? 'var(--sf-fg-3)' : 'var(--sf-fg-1)',
    fontStyle: untitled ? 'italic' : 'normal',
    lineHeight: 1.3,
    letterSpacing: '-0.01em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginBottom: 3,
  };

  const time: CSSProperties = {
    display: 'block',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.2,
  };

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      style={wrap}
      data-testid="session-row"
      data-conversation-id={conversation.id}
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      aria-label={`Conversation ${title}, ${formatUpdatedAt(conversation.updatedAt)}`}
    >
      <span style={titleStyle} data-testid="session-row-title">
        {title}
      </span>
      <span style={time}>{formatUpdatedAt(conversation.updatedAt)}</span>
    </button>
  );
}
