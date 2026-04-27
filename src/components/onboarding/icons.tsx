// Hand-rolled 16×16 SVG icons. Paths copied verbatim from the handoff
// (`design_handoff_onboarding_v2/primitives.jsx`, `Icon` object).
//
// All stroke icons use `stroke="currentColor" strokeWidth="1.5" fill="none"`
// so consumers restyle via CSS `color`. Brand marks (github, reddit, x) are
// filled with `currentColor`.

import type { SVGProps } from 'react';

export interface OnbIconProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number;
}

function strokeProps(size = 14) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export function ArrowRight({ size = 14, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

export function ArrowLeft({ size = 14, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </svg>
  );
}

export function Check({ size = 14, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} strokeWidth={1.75} {...rest}>
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
  );
}

export function Globe({ size = 18, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <circle cx={8} cy={8} r={6.25} />
      <path d="M1.75 8h12.5M8 1.75c1.9 2.3 2.75 4.4 2.75 6.25S9.9 11.95 8 14.25M8 1.75C6.1 4.05 5.25 6.15 5.25 8S6.1 11.95 8 14.25" />
    </svg>
  );
}

export function GitHub({ size = 18, ...rest }: OnbIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function Pencil({ size = 18, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <path d="M11 2.5l2.5 2.5-8 8H3v-2.5z" />
      <path d="M10 3.5l2.5 2.5" />
    </svg>
  );
}

export function Reddit({ size = 18, ...rest }: OnbIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path d="M16 8a1.5 1.5 0 0 0-2.55-1.06A7.5 7.5 0 0 0 9.29 5.6L10.08 3l2.3.54a1 1 0 1 0 .08-.5L9.83 2.41a.25.25 0 0 0-.3.17L8.67 5.54a7.47 7.47 0 0 0-4.11 1.4A1.5 1.5 0 1 0 2.7 9.05a3.06 3.06 0 0 0-.04.55c0 2.75 3.07 4.98 6.84 4.98s6.84-2.23 6.84-4.98a3.06 3.06 0 0 0-.04-.56A1.5 1.5 0 0 0 16 8zM5 9a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm5.83 2.88c-.71.71-2.07.77-2.47.77s-1.76-.06-2.47-.77a.27.27 0 0 1 .38-.38c.45.45 1.41.61 2.09.61s1.64-.16 2.09-.61a.27.27 0 0 1 .38.38zM10 10a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
    </svg>
  );
}

export function X({ size = 16, ...rest }: OnbIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path d="M12.15 1.75h2.3l-5.02 5.74 5.9 7.8h-4.62l-3.62-4.73-4.14 4.73H.65l5.37-6.14L.35 1.75h4.74l3.27 4.32zM11.34 13.91h1.27L4.71 3.07H3.34z" />
    </svg>
  );
}

export function XClose({ size = 12, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

export function Search({ size = 14, ...rest }: OnbIconProps) {
  return (
    <svg {...strokeProps(size)} {...rest}>
      <circle cx={7} cy={7} r={4.75} />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export const OnbIcons = {
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  check: Check,
  globe: Globe,
  github: GitHub,
  pencil: Pencil,
  reddit: Reddit,
  x: X,
  xClose: XClose,
  search: Search,
} as const;

export type OnbIconName = keyof typeof OnbIcons;
