import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

/**
 * Accepts a semantic color name (matches a `--sf-*` color token).
 * Example: `accent="accent"` paints a 3px bar in `var(--sf-accent)`.
 */
export type CardAccent =
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | (string & {});

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  children: ReactNode;
  /** Pixel padding for every side. Defaults to 20. */
  padding?: number;
  /** Accent stripe color — name of a `--sf-*` color token. */
  accent?: CardAccent;
  style?: CSSProperties;
}

/**
 * Raised surface — the default container for content blocks.
 * The `accent` prop paints a 3px left stripe in the chosen brand color.
 */
export function Card({
  children,
  padding = 20,
  accent,
  className = '',
  style: styleOverride,
  ...rest
}: CardProps) {
  const style: CSSProperties = {
    background: 'var(--sf-bg-secondary)',
    borderRadius: 'var(--sf-radius-xl)',
    boxShadow: 'var(--sf-shadow-card)',
    padding,
    position: 'relative',
    overflow: 'hidden',
    ...(accent ? { borderLeft: `3px solid var(--sf-${accent})` } : {}),
    ...styleOverride,
  };
  return (
    <div className={className} style={style} {...rest}>
      {children}
    </div>
  );
}
