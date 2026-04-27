import type { CSSProperties } from 'react';

/**
 * Shown by the App Router while `/team/page.tsx` (force-dynamic, DB
 * reads + session snapshot) is streaming. Without this, clicking the
 * sidebar link blocks on SSR before any pixel moves and the app
 * feels frozen. The skeleton mirrors the real three-column TeamDesk
 * so layout shift is minimal when the real page takes over.
 */
export default function TeamLoading() {
  return (
    <div style={root} role="status" aria-label="Loading your AI team">
      <div style={grid}>
        <div style={leftColumn}>
          <div style={{ ...block, height: 40 }} />
          <div style={{ ...block, height: 140, marginTop: 12 }} />
          <div style={{ ...block, height: 180, marginTop: 12 }} />
        </div>

        <div style={centerColumn}>
          <div style={{ ...block, height: 56 }} />
          <div style={threadStack}>
            <div style={{ ...bubble, width: '62%' }} />
            <div style={{ ...bubble, width: '78%', alignSelf: 'flex-end' }} />
            <div style={{ ...bubble, width: '54%' }} />
            <div style={{ ...bubble, width: '88%' }} />
          </div>
          <div style={{ ...block, height: 72, marginTop: 'auto' }} />
        </div>

        <div style={rightColumn}>
          <div style={{ ...block, height: 120 }} />
          <div style={{ ...block, height: 220, marginTop: 12 }} />
        </div>
      </div>

      <style>{`
        @keyframes sf-skeleton-shimmer {
          0% { opacity: 0.55; }
          50% { opacity: 0.9; }
          100% { opacity: 0.55; }
        }
      `}</style>
    </div>
  );
}

const root: CSSProperties = {
  padding: 24,
  minHeight: '100%',
  boxSizing: 'border-box',
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '280px 1fr 380px',
  gap: 20,
  height: 'calc(100vh - 96px)',
  minHeight: 500,
};

const columnBase: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const leftColumn: CSSProperties = { ...columnBase };

const centerColumn: CSSProperties = {
  ...columnBase,
  gap: 12,
};

const rightColumn: CSSProperties = { ...columnBase };

const block: CSSProperties = {
  background: 'var(--sf-bg-secondary, rgba(0, 0, 0, 0.04))',
  borderRadius: 10,
  border: '1px solid rgba(0, 0, 0, 0.05)',
  animation: 'sf-skeleton-shimmer 1.4s ease-in-out infinite',
};

const threadStack: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 4,
};

const bubble: CSSProperties = {
  height: 48,
  background: 'var(--sf-bg-secondary, rgba(0, 0, 0, 0.04))',
  borderRadius: 12,
  border: '1px solid rgba(0, 0, 0, 0.05)',
  animation: 'sf-skeleton-shimmer 1.4s ease-in-out infinite',
};
