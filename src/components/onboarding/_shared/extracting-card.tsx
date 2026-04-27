// ExtractingCard — black centered spinner card shown while Stage 1's
// in-flow scan is running (before advancing to Stage 2). Kept thin; Stage 2
// owns the 6-step animation.

import { OnbMono } from './onb-mono';

interface ExtractingCardProps {
  label: string;
  hint: string;
}

export function ExtractingCard({ label, hint }: ExtractingCardProps) {
  return (
    <div
      style={{
        background: 'var(--sf-bg-dark)',
        color: '#fff',
        borderRadius: 12,
        padding: '40px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 14,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.12)',
          borderTopColor: 'var(--sf-accent)',
          animation: 'sfSpin 800ms linear infinite',
        }}
      />
      <div
        style={{
          fontSize: 17,
          fontWeight: 500,
          letterSpacing: '-0.224px',
        }}
      >
        {label}…
      </div>
      <OnbMono color="var(--sf-fg-on-dark-4)">{hint}</OnbMono>
      <style>{`@keyframes sfSpin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
