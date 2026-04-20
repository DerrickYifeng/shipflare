import type { CSSProperties } from 'react';

export interface HealthMeterProps {
  /** 0–1 (bar mode) or 0–100 (dial mode). */
  value: number;
  /** Rendering style. Defaults to 'bar'. */
  variant?: 'bar' | 'dial';
  /** Dial diameter (dial variant only). Defaults to 132. */
  size?: number;
}

/**
 * HealthMeter — dual-mode visual for 0-100 health scores.
 *
 * - `variant="bar"` (default): thin 56×4 progress bar. Used inline in tables
 *   (e.g. Growth communities list). Accepts 0–1 for compatibility with the
 *   handoff prototype's community rows.
 * - `variant="dial"`: 0–100 arc dial as the Growth page centerpiece. Color
 *   shifts from warning → signal → success as the score climbs.
 *
 * Compositor-friendly: the fill/arc uses SVG + CSS transforms only.
 */
export function HealthMeter({ value, variant = 'bar', size = 132 }: HealthMeterProps) {
  if (variant === 'dial') return <HealthDial value={value} size={size} />;
  return <HealthBar value={value} />;
}

function colorFor(v01: number): string {
  if (v01 > 0.75) return 'var(--sf-success)';
  if (v01 > 0.55) return 'var(--sf-accent)';
  return 'var(--sf-warning)';
}

function HealthBar({ value }: { value: number }) {
  // Accept both 0–1 and 0–100 inputs transparently.
  const v01 = value > 1 ? value / 100 : value;
  const clamped = Math.max(0, Math.min(1, v01));
  return (
    <div
      style={{
        width: 56,
        height: 4,
        borderRadius: 2,
        background: 'var(--sf-bg-tertiary)',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${clamped * 100}%`,
          background: colorFor(clamped),
          borderRadius: 2,
        }}
      />
    </div>
  );
}

function HealthDial({ value, size }: { value: number; size: number }) {
  // Always normalize to 0–100 for the dial label; arc uses 0–1.
  const score100 = Math.max(0, Math.min(100, Math.round(value > 1 ? value : value * 100)));
  const v01 = score100 / 100;
  const color = colorFor(v01);

  // 3/4 circle arc — 270° sweep from 135° to 405°, leaving a gap at the bottom.
  const strokeWidth = Math.round(size * 0.1);
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const sweepAngle = 270;
  const arcLength = (sweepAngle / 360) * (2 * Math.PI * radius);
  const dashOffset = arcLength * (1 - v01);

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    position: 'relative',
    display: 'inline-block',
  };

  return (
    <div style={containerStyle} role="img" aria-label={`Health score ${score100} of 100`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block' }}
        aria-hidden="true"
      >
        {/* Track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--sf-bg-tertiary)"
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${2 * Math.PI * radius}`}
          strokeLinecap="round"
          transform={`rotate(135 ${center} ${center})`}
        />
        {/* Progress */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${2 * Math.PI * radius}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(135 ${center} ${center})`}
          style={{ transition: 'stroke-dashoffset var(--sf-dur-slow) var(--sf-ease-swift), stroke var(--sf-dur-slow) var(--sf-ease-swift)' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <div
          className="sf-mono"
          style={{
            fontSize: Math.round(size * 0.32),
            fontWeight: 600,
            color: 'var(--sf-fg-1)',
            lineHeight: 1,
            letterSpacing: 'var(--sf-track-tight)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {score100}
        </div>
        <div
          className="sf-ops"
          style={{
            color: 'var(--sf-fg-3)',
            fontSize: Math.max(9, Math.round(size * 0.075)),
          }}
        >
          / 100
        </div>
      </div>
    </div>
  );
}
