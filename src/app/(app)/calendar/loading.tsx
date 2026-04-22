import { HeaderBar } from '@/components/layout/header-bar';

/**
 * Calendar skeleton — approximates the time-grid layout so the
 * skeleton→real-view transition does not produce a layout shift.
 *
 * Shape:
 *   - HeaderBar (matches the real view)
 *   - Sticky day-column header row (7 pills)
 *   - Time-grid body: 56px left rail + 7 day columns divided by hairlines
 */

const LEFT_RAIL_PX = 56;

export default function CalendarLoading() {
  return (
    <>
      <HeaderBar title="Calendar" />
      <div
        style={{
          padding: '0 clamp(16px, 3vw, 32px) 48px',
        }}
      >
        {/* Day-column header row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${LEFT_RAIL_PX}px repeat(7, minmax(0, 1fr))`,
            borderBottom: '1px solid rgba(0,0,0,0.06)',
            marginBottom: 0,
          }}
        >
          {/* Rail spacer */}
          <div style={{ height: 44 }} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: '10px 12px',
                borderLeft: '1px solid rgba(0,0,0,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {/* Weekday pill */}
              <div
                style={{
                  width: 26,
                  height: 10,
                  background: 'rgba(0,0,0,0.06)',
                  borderRadius: 3,
                }}
              />
              {/* Day number pill */}
              <div
                style={{
                  width: 40,
                  height: 12,
                  background: 'rgba(0,0,0,0.04)',
                  borderRadius: 3,
                }}
              />
            </div>
          ))}
        </div>

        {/* Time-grid body */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${LEFT_RAIL_PX}px repeat(7, minmax(0, 1fr))`,
            minHeight: 560,
            border: '1px solid rgba(0,0,0,0.06)',
            borderTop: 'none',
          }}
        >
          {/* Left rail */}
          <div
            style={{
              borderRight: '1px solid rgba(0,0,0,0.06)',
              background: 'transparent',
            }}
          />
          {/* 7 day columns */}
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              style={{
                borderLeft: '1px solid rgba(0,0,0,0.06)',
                minHeight: 560,
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
