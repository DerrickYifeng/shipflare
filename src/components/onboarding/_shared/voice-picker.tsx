// VoicePicker — 4 preset capsule chips + freeform input for the voice field.
// Selected chip: black bg, white text. Freeform input commits the raw value
// as the voice string — presets are just convenience pickers.

import { OnbInput } from './onb-input';

interface VoicePickerProps {
  value: string;
  onChange: (v: string) => void;
  presets: readonly string[];
  freeformPlaceholder: string;
}

export function VoicePicker({
  value,
  onChange,
  presets,
  freeformPlaceholder,
}: VoicePickerProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {presets.map((p) => {
          const on = value === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
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
              {p}
            </button>
          );
        })}
      </div>
      <OnbInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={freeformPlaceholder}
      />
    </div>
  );
}
