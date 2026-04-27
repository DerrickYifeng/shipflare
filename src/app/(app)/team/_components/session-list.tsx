'use client';

import type { CSSProperties } from 'react';
import { SessionRow } from './session-row';
import type { ConversationMeta } from './conversation-meta';

export interface SessionListProps {
  conversations: readonly ConversationMeta[];
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  canCreate: boolean;
  creating: boolean;
}

const MAX_HEIGHT = 460;

const NEW_DISABLED_TOOLTIP =
  'Hang on — still spinning up a new conversation.';

/**
 * Conversation-first sidebar. No more session/run grouping. Rows are
 * conversations (1:1 with the `team_conversations` table); clicking
 * one makes it the focus; "+ New" creates an empty conversation and
 * focuses it. Composer routes the next send explicitly into the
 * focused conversation id.
 */
export function SessionList({
  conversations,
  selectedConversationId,
  onSelect,
  onNewConversation,
  canCreate,
  creating,
}: SessionListProps) {
  const sectionHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px 6px',
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  const sectionLeft: CSSProperties = { color: 'var(--sf-fg-1)' };
  const sectionRight: CSSProperties = { color: 'rgba(0, 0, 0, 0.48)' };

  const newButton: CSSProperties = {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 32,
    margin: '2px 0 6px',
    padding: '0 12px',
    borderRadius: 8,
    border: '1px dashed rgba(0, 0, 0, 0.18)',
    background: 'transparent',
    color: canCreate ? 'var(--sf-fg-1)' : 'var(--sf-fg-4)',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: canCreate ? 'pointer' : 'not-allowed',
    opacity: canCreate ? 1 : 0.7,
  };

  const scroll: CSSProperties = {
    maxHeight: MAX_HEIGHT,
    overflowY: 'auto',
    paddingRight: 2,
  };

  const empty: CSSProperties = {
    padding: '10px 12px',
    fontSize: 12,
    color: 'var(--sf-fg-4)',
    fontStyle: 'italic',
  };

  const newLabel = creating ? 'Creating…' : '+ New conversation';

  return (
    <section aria-label="Conversations">
      <div style={sectionHeader}>
        <span style={sectionLeft}>Conversations</span>
        <span style={sectionRight}>{`${conversations.length}`}</span>
      </div>

      <button
        type="button"
        onClick={onNewConversation}
        disabled={!canCreate || creating}
        aria-disabled={!canCreate}
        title={canCreate ? undefined : NEW_DISABLED_TOOLTIP}
        style={newButton}
        data-testid="new-conversation-button"
      >
        {newLabel}
      </button>

      <div style={scroll} data-testid="conversation-scroll">
        {conversations.length === 0 ? (
          <div style={empty}>No conversations yet</div>
        ) : (
          conversations.map((c) => (
            <SessionRow
              key={c.id}
              conversation={c}
              active={selectedConversationId === c.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}
