import { HeaderBar } from '@/components/layout/header-bar';

/**
 * Calendar skeleton — 7 day columns with greyed placeholder cards. Matches
 * the desktop grid so the paint doesn't jump when data arrives.
 */
export default function CalendarLoading() {
  return (
    <>
      <HeaderBar title="Calendar" />
      <div
        style={{
          padding: '16px clamp(16px, 3vw, 32px) 48px',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            style={{
              background: 'var(--sf-bg-secondary)',
              borderRadius: 8,
              padding: 12,
              height: 220,
              border: '1px solid rgba(0,0,0,0.04)',
            }}
          >
            <div
              style={{
                width: 80,
                height: 14,
                background: 'rgba(0,0,0,0.06)',
                borderRadius: 4,
                marginBottom: 14,
              }}
            />
            <div
              style={{
                width: '100%',
                height: 48,
                background: 'rgba(0,0,0,0.04)',
                borderRadius: 6,
                marginBottom: 10,
              }}
            />
            <div
              style={{
                width: '80%',
                height: 48,
                background: 'rgba(0,0,0,0.04)',
                borderRadius: 6,
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}
