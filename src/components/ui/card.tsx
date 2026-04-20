import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

/**
 * Accepts any `--sf-*` color token name (without the `--sf-` prefix)
 * to paint as the left-edge accent stripe. Example: `accent="signal"`
 * renders a 3px bar in `var(--sf-signal)`.
 */
export type CardAccent =
  | 'signal'
  | 'flare'
  | 'success'
  | 'warning'
  | 'danger'
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
 * Raised paper surface — the default container for content blocks.
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
    background: 'var(--sf-paper-raised)',
    borderRadius: 'var(--sf-radius-lg)',
    boxShadow: 'var(--sf-shadow-sm)',
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
