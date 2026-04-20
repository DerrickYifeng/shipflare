// CategoryPicker — 7 capsule chips, radio-group behavior.
// Matches the Stage 3 `VoicePicker` preset chip style so the review
// form reads as a consistent list of 6-ish editable bands.

import type { ProductCategory } from '../OnboardingFlow';

export interface CategoryOption {
  readonly id: ProductCategory;
  readonly label: string;
}

interface CategoryPickerProps {
  value: ProductCategory;
  onChange: (next: ProductCategory) => void;
  options: readonly CategoryOption[];
}

export function CategoryPicker({
  value,
  onChange,
  options,
}: CategoryPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Product category"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
    >
      {options.map((opt) => {
        const on = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(opt.id)}
            style={{
              padding: '6px 12px',
              borderRadius: 980,
              background: on ? 'var(--sf-fg-1)' : 'var(--sf-bg-secondary)',
              color: on ? '#fff' : 'rgba(0,0,0,0.72)',
              border: `1px solid ${
                on ? 'var(--sf-fg-1)' : 'rgba(0,0,0,0.10)'
              }`,
              fontFamily: 'inherit',
              fontSize: 13,
              letterSpacing: '-0.16px',
              cursor: 'pointer',
              transition:
                'background 150ms cubic-bezier(0.16,1,0.3,1), color 150ms',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
