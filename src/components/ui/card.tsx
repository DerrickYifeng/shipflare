import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  elevated?: boolean;
}

export function Card({ children, elevated, className = '', ...props }: CardProps) {
  return (
    <div
      className={`
        bg-sf-bg-secondary
        rounded-[var(--radius-sf-lg)] p-5
        ${elevated ? 'shadow-[var(--shadow-sf-elevated)]' : 'shadow-[var(--shadow-sf-card)]'}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}
