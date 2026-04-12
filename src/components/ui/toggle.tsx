'use client';

import { useState, type ReactNode } from 'react';

interface ToggleProps {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function Toggle({ label, children, defaultOpen = false }: ToggleProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="
          flex items-center gap-1.5
          text-[13px] text-sf-text-secondary
          hover:text-sf-text-primary
          transition-colors duration-150
          cursor-pointer min-h-[44px]
        "
        aria-expanded={open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {label}
      </button>
      {open && (
        <div className="mt-1.5 pl-4 animate-sf-fade-in">
          {children}
        </div>
      )}
    </div>
  );
}
