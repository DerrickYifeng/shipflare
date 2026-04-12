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
            className="text-[13px] font-medium text-sf-text-primary"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            className={`
              w-full min-h-[44px] px-3 py-2
              rounded-[var(--radius-sf-md)]
              border text-[15px] text-sf-text-primary
              bg-sf-bg-primary placeholder:text-sf-text-tertiary
              transition-colors duration-150
              ${error ? 'border-sf-error' : 'border-sf-border hover:border-sf-text-tertiary focus:border-sf-accent'}
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
          <p id={`${inputId}-error`} className="text-[13px] text-sf-error">
            {error}
          </p>
        )}
        {!error && helper && (
          <p id={`${inputId}-helper`} className="text-[13px] text-sf-text-tertiary">
            {helper}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
