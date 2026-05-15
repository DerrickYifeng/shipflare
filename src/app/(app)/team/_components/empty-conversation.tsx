'use client';

import type { CSSProperties } from 'react';

/**
 * Suggested prompts surfaced in the empty conversation state. Clicking
 * a chip prefills the sticky composer so the user can edit before
 * sending. Keep the list short and concrete — these are demonstrations
 * of what the Team Lead can do, not an exhaustive menu.
 */
const SUGGESTION_CHIPS: readonly string[] = [
  "Plan next week's posts for my product",
  'Find 3 Reddit threads I should reply to today',
  'Draft a launch-day announcement for X',
];

interface EmptyStateProps {
  onPrefillComposer?: (text: string) => void;
  onFocusComposer?: () => void;
}

/**
 * Empty conversation state shown when the selected thread has no
 * messages yet. Renders an explanatory line plus a row of suggestion
 * chips that prefill the composer. Lives outside `conversation.tsx`
 * so that file stays under the 800-line cohesion ceiling — this pair
 * has no dependency on streaming/scroll state and is safe to extract.
 */
export function EmptyConversation({
  onPrefillComposer,
  onFocusComposer,
}: EmptyStateProps) {
  const wrap: CSSProperties = {
    padding: '32px 20px',
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
    textAlign: 'center',
    color: 'rgba(0, 0, 0, 0.48)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
  };
  return (
    <div style={wrap}>
      <span>
        Send your Team Lead a message below — it&apos;s always here, ready to
        spin up specialists in parallel.
      </span>
      <SuggestionChips
        onPrefillComposer={onPrefillComposer}
        onFocusComposer={onFocusComposer}
      />
    </div>
  );
}

interface SuggestionChipsProps {
  onPrefillComposer?: (text: string) => void;
  onFocusComposer?: () => void;
}

function SuggestionChips({
  onPrefillComposer,
  onFocusComposer,
}: SuggestionChipsProps) {
  if (!onPrefillComposer && !onFocusComposer) return null;
  const row: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  };
  const chip: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 12px',
    borderRadius: 8,
    background: 'var(--sf-bg-tertiary)',
    color: 'var(--sf-fg-1)',
    fontSize: 12,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 160ms var(--sf-ease-swift)',
  };
  const handleClick = (text: string) => {
    if (onPrefillComposer) {
      onPrefillComposer(text);
      return;
    }
    onFocusComposer?.();
  };
  return (
    <div style={row} data-testid="suggestion-chips">
      {SUGGESTION_CHIPS.map((text) => (
        <button
          key={text}
          type="button"
          style={chip}
          onClick={() => handleClick(text)}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'var(--sf-bg-primary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'var(--sf-bg-tertiary)';
          }}
          data-testid="suggestion-chip"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
