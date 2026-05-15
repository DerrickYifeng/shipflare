'use client';

interface HealthScoreRingProps {
  score: number;
  size?: number;
}

export function HealthScoreRing({ score, size = 36 }: HealthScoreRingProps) {
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const color =
    score >= 70
      ? 'var(--color-sf-success)'
      : score >= 40
        ? 'var(--color-sf-warning)'
        : 'var(--color-sf-error)';

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="rotate-[-90deg]"
      role="img"
      aria-label={`Health score: ${score}`}
      style={
        {
          '--sf-score-circumference': circumference,
          '--sf-score-offset': offset,
        } as React.CSSProperties
      }
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-sf-border)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="animate-sf-score"
      />
    </svg>
  );
}
