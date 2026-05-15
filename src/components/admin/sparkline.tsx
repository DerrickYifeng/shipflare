export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}

/**
 * Minimal inline-SVG sparkline. No deps. Renders an empty SVG when
 * values is empty. Flat baseline (mid-height) when all values are equal.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  stroke = 'var(--sf-accent)',
}: SparklineProps) {
  if (values.length === 0) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = max === min ? height : height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
