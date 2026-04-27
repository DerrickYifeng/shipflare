'use client';

/**
 * Inline click-to-edit primitive used by the Product page FieldRows.
 *
 * States: display (default) → editing (click or Enter/Space on focused display) →
 * saving (commit) → display (with optional optimistic value). On failure the
 * caller rolls the value back and surfaces a toast.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface EditableValueProps {
  value: string;
  onCommit: (next: string) => Promise<void> | void;
  /** Optional placeholder text for empty values. */
  placeholder?: string;
  /** Render value as multiline textarea instead of single-line input. */
  multiline?: boolean;
  /** Format the display value (e.g. wrap in quotes). */
  renderDisplay?: (value: string) => React.ReactNode;
}

export function EditableValue({
  value,
  onCommit,
  placeholder = 'Click to edit',
  multiline = false,
  renderDisplay,
}: EditableValueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Reset draft whenever the authoritative value changes — e.g. after SWR revalidation.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Auto-grow the textarea to fit its content so multi-line values aren't
  // visually truncated to a fixed `rows={3}` viewport when editing.
  useLayoutEffect(() => {
    if (!editing || !multiline) return;
    const el = inputRef.current as HTMLTextAreaElement | null;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, multiline, draft]);

  const commit = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !multiline) {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Enter' && event.metaKey) {
      event.preventDefault();
      void commit();
    }
  };

  if (editing) {
    const commonStyle = {
      width: '100%',
      padding: multiline ? 8 : '6px 8px',
      fontSize: 'var(--sf-text-sm)',
      color: 'var(--sf-fg-1)',
      background: 'var(--sf-bg-tertiary)',
      border: '1px solid var(--sf-accent)',
      borderRadius: 'var(--sf-radius-sm)',
      outline: 'none',
      fontFamily: 'inherit',
      opacity: saving ? 0.6 : 1,
    } as const;

    return multiline ? (
      <textarea
        ref={(el) => {
          inputRef.current = el;
        }}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        rows={2}
        style={{
          ...commonStyle,
          resize: 'vertical',
          minHeight: 64,
          overflow: 'hidden',
          lineHeight: 'var(--sf-lh-normal)',
        }}
      />
    ) : (
      <input
        ref={(el) => {
          inputRef.current = el;
        }}
        type="text"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        style={commonStyle}
      />
    );
  }

  const empty = !value || value.trim() === '';
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: 0,
        margin: 0,
        background: 'transparent',
        border: 'none',
        borderBottom: '1px dashed transparent',
        color: empty ? 'var(--sf-fg-3)' : 'var(--sf-fg-1)',
        fontSize: 'var(--sf-text-sm)',
        fontStyle: empty ? 'italic' : 'normal',
        cursor: 'text',
        fontFamily: 'inherit',
        whiteSpace: multiline ? 'pre-wrap' : 'normal',
        wordBreak: 'break-word',
        lineHeight: 'var(--sf-lh-normal)',
        transition: 'border-color var(--sf-dur-fast) var(--sf-ease-swift)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'var(--sf-border)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'transparent';
      }}
    >
      {empty ? placeholder : renderDisplay ? renderDisplay(value) : value}
    </button>
  );
}
