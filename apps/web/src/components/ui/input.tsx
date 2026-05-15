import { type InputHTMLAttributes, forwardRef, type ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helper?: string;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helper, suffix, className = '', id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-[14px] font-semibold text-sf-text-primary tracking-[-0.224px]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            className={`
              w-full min-h-[44px] px-[14px] py-2
              rounded-[11px]
              border text-[17px] tracking-[-0.374px] text-sf-text-primary
              bg-sf-bg-secondary placeholder:text-sf-text-tertiary
              transition-all duration-200
              ${error
                ? 'border-sf-error'
                : 'border-sf-border hover:border-black/[0.16] focus:border-sf-accent focus:shadow-[0_0_0_3px_rgba(0,113,227,0.12)]'
              }
              ${suffix ? 'pr-10' : ''}
              ${className}
            `}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? `${inputId}-error` : helper ? `${inputId}-helper` : undefined}
            {...props}
          />
          {suffix && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-sf-text-tertiary">
              {suffix}
            </div>
          )}
        </div>
        {error && (
          <p id={`${inputId}-error`} className="text-[12px] text-sf-error tracking-[-0.12px]">
            {error}
          </p>
        )}
        {!error && helper && (
          <p id={`${inputId}-helper`} className="text-[12px] text-sf-text-tertiary tracking-[-0.12px]">
            {helper}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
