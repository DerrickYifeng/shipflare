import { type ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-sf-accent text-white hover:bg-sf-accent-hover active:bg-sf-accent-hover',
  secondary:
    'bg-sf-bg-secondary text-sf-text-primary border border-sf-border hover:bg-sf-bg-tertiary active:bg-sf-bg-tertiary',
  ghost:
    'bg-transparent text-sf-text-secondary hover:bg-sf-bg-secondary active:bg-sf-bg-tertiary',
  danger:
    'bg-sf-error text-white hover:bg-red-700 active:bg-red-800',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', className = '', children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`
          inline-flex items-center justify-center gap-2
          min-h-[44px] px-4 py-2
          rounded-[var(--radius-sf-md)] font-medium text-[15px]
          transition-colors duration-150
          disabled:opacity-50 disabled:pointer-events-none
          cursor-pointer
          ${variantStyles[variant]}
          ${className}
        `}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
