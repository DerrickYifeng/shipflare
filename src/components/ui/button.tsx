import { type ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'pill';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-sf-accent text-white hover:bg-sf-accent-hover active:brightness-95',
  secondary:
    'bg-sf-bg-dark-surface text-white hover:bg-[#2c2c2e] active:bg-[#3a3a3c]',
  ghost:
    'bg-transparent text-sf-text-secondary hover:bg-black/[0.04] active:bg-black/[0.06]',
  danger:
    'bg-sf-error text-white hover:brightness-110 active:brightness-95',
  pill:
    'bg-transparent text-sf-link border border-sf-link hover:bg-sf-link hover:text-white active:brightness-95',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', className = '', children, disabled, ...props }, ref) => {
    const isPill = variant === 'pill';
    return (
      <button
        ref={ref}
        className={`
          inline-flex items-center justify-center gap-2
          min-h-[44px] px-[15px] py-2
          ${isPill ? 'rounded-[var(--radius-sf-pill)]' : 'rounded-[var(--radius-sf-md)]'}
          font-normal text-[17px] tracking-[-0.374px]
          transition-all duration-200
          disabled:opacity-40 disabled:pointer-events-none
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
