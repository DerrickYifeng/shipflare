import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <div
      className={`
        bg-sf-bg-primary border border-sf-border
        rounded-[var(--radius-sf-lg)] p-4
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}
