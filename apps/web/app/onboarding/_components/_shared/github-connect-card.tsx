// GithubConnectCard — dark authorize card shown when user has not linked GitHub.
// Button redirects to Auth.js GitHub provider via signIn('github').

import { GitHub } from '../icons';

interface GithubConnectCardProps {
  connecting: boolean;
  onConnect: () => void;
  title: string;
  sub: string;
  button: string;
  connectingButton: string;
}

export function GithubConnectCard({
  connecting,
  onConnect,
  title,
  sub,
  button,
  connectingButton,
}: GithubConnectCardProps) {
  return (
    <div
      style={{
        background: 'var(--sf-bg-dark-surface)',
        color: '#fff',
        borderRadius: 12,
        padding: '28px 24px',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: 'var(--sf-bg-dark)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}
      >
        <GitHub />
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '-0.224px',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.47,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-on-dark-3)',
          maxWidth: 400,
          marginBottom: 18,
        }}
      >
        {sub}
      </div>
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 18px',
          borderRadius: 980,
          background: '#fff',
          color: 'var(--sf-fg-1)',
          border: 'none',
          cursor: connecting ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontSize: 14,
          letterSpacing: '-0.224px',
          fontWeight: 500,
          opacity: connecting ? 0.6 : 1,
        }}
      >
        <GitHub /> {connecting ? connectingButton : button}
      </button>
    </div>
  );
}
