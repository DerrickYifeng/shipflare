import type { CSSProperties } from 'react';

export interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  const row: CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: 14,
  };

  const bubble: CSSProperties = {
    maxWidth: '78%',
    background: 'var(--sf-accent)',
    color: 'var(--sf-fg-on-dark-1)',
    padding: '10px 14px',
    borderRadius: 14,
    fontSize: 14,
    letterSpacing: '-0.01em',
    lineHeight: 1.47,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    animation: 'var(--animate-sf-fade-in)',
  };

  return (
    <div style={row} data-testid="user-message">
      <div style={bubble}>{text}</div>
    </div>
  );
}
