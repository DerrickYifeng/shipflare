// KeywordEditor — chip-tokenized keyword input. Enter/comma commits,
// blur also commits. No duplicates. Remove via small x button on each chip.

import { useState, type KeyboardEvent } from 'react';

interface KeywordEditorProps {
  keywords: string[];
  onChange: (next: string[]) => void;
  placeholderEmpty: string;
  placeholderMore: string;
}

export function KeywordEditor({
  keywords,
  onChange,
  placeholderEmpty,
  placeholderMore,
}: KeywordEditorProps) {
  const [input, setInput] = useState('');

  const commit = () => {
    const v = input.trim();
    if (!v) return;
    if (!keywords.includes(v)) {
      onChange([...keywords, v]);
    }
    setInput('');
  };

  const remove = (k: string) => {
    onChange(keywords.filter((x) => x !== k));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Backspace' && input === '' && keywords.length > 0) {
      onChange(keywords.slice(0, -1));
    }
  };

  return (
    <div
      style={{
        minHeight: 48,
        padding: '8px 10px',
        borderRadius: 10,
        border: '1px solid rgba(0,0,0,0.12)',
        background: 'var(--sf-bg-secondary)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
      }}
    >
      {keywords.map((k) => (
        <span
          key={k}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 6px 4px 10px',
            borderRadius: 980,
            background: 'var(--sf-bg-primary)',
            fontSize: 13,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-1)',
          }}
        >
          {k}
          <button
            type="button"
            onClick={() => remove(k)}
            aria-label={`Remove ${k}`}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.06)',
              color: 'var(--sf-fg-3)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M1 1l6 6M7 1l-6 6" />
            </svg>
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={keywords.length === 0 ? placeholderEmpty : placeholderMore}
        style={{
          flex: 1,
          minWidth: 120,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'inherit',
          fontSize: 13,
          letterSpacing: '-0.16px',
          padding: '4px',
          color: 'var(--sf-fg-1)',
        }}
      />
    </div>
  );
}
