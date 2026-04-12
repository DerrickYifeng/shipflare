import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'accent';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  mono?: boolean;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-sf-bg-tertiary text-sf-text-secondary',
  success: 'bg-sf-success-light text-sf-success',
  warning: 'bg-sf-warning-light text-sf-warning',
  error: 'bg-sf-error-light text-sf-error',
  accent: 'bg-sf-accent-light text-sf-accent',
};

export function Badge({ children, variant = 'default', mono, className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center px-2 py-0.5
        rounded-[var(--radius-sf-sm)]
        text-[11px] font-medium leading-4
        ${mono ? 'font-mono' : ''}
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
