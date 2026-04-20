import type { CSSProperties } from 'react';

export interface SkeletonProps {
  /** CSS length (e.g. "100%", 240, "12rem"). Defaults to "100%". */
  width?: number | string;
  /** CSS length. Defaults to 12. */
  height?: number | string;
  /** Border radius in pixels. Defaults to 4. */
  radius?: number;
  /**
   * Tailwind / utility classes for ad-hoc sizing (e.g. `h-20 w-full`).
   * When supplied, callers may omit `width`/`height` entirely.
   */
  className?: string;
}

/**
 * Shimmer loading placeholder using the `sf-shimmer` keyframe.
 * Supports both prop-based sizing (`width`, `height`) and
 * utility className sizing for flexibility.
 */
export function Skeleton({
  width,
  height,
  radius = 4,
  className = '',
}: SkeletonProps) {
  // When className is provided, don't force width/height — let utilities control.
  const hasClassName = className.trim().length > 0;
  const style: CSSProperties = {
    width: hasClassName && width === undefined ? undefined : width ?? '100%',
    height: hasClassName && height === undefined ? undefined : height ?? 12,
    borderRadius: radius,
    background:
      'linear-gradient(90deg, var(--sf-bg-tertiary) 0%, var(--sf-bg-primary) 50%, var(--sf-bg-tertiary) 100%)',
    backgroundSize: '200% 100%',
    animation: 'sf-shimmer 1.4s ease-in-out infinite',
  };
  return <div className={className} style={style} aria-hidden="true" />;
}
