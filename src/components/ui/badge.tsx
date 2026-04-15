import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'accent';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  mono?: boolean;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-black/[0.05] text-sf-text-secondary',
  success: 'bg-sf-success-light text-[#248a3d]',
  warning: 'bg-sf-warning-light text-[#c67a05]',
  error: 'bg-sf-error-light text-[#d70015]',
  accent: 'bg-sf-accent-light text-sf-accent',
};

export function Badge({ children, variant = 'default', mono, className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center px-2 py-0.5
        rounded-[var(--radius-sf-sm)]
        text-[12px] font-medium leading-4 tracking-[-0.12px]
        ${mono ? 'font-mono' : ''}
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
