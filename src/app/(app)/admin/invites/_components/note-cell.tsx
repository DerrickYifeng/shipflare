'use client';

import { useState, useTransition } from 'react';
import { updateNote } from '../actions';

/**
 * Click-to-edit note cell. Idle state: plain text or a "+ note" placeholder.
 * Clicking swaps to a textarea + Save / Cancel. Save calls the
 * `updateNote` server action; revalidatePath in the action refreshes
 * the list automatically.
 */
export function NoteCell({
  email,
  initial,
}: {
  email: string;
  initial: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? '');
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          color: initial ? 'var(--sf-fg-2)' : 'var(--sf-fg-4)',
          cursor: 'pointer',
          fontSize: 13,
          fontFamily: 'inherit',
        }}
      >
        {initial ?? '+ note'}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.set('email', email);
        fd.set('note', value);
        startTransition(async () => {
          const result = await updateNote(fd);
          if (!result.ok) {
            window.alert(`Save failed: ${result.error}`);
            return;
          }
          setEditing(false);
        });
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={500}
        rows={2}
        autoFocus
        style={{
          width: '100%',
          minWidth: 200,
          padding: 6,
          fontSize: 12,
          background: 'var(--sf-bg-1)',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 3,
          color: 'var(--sf-fg-1)',
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            background: 'var(--sf-fg-1)',
            color: 'var(--sf-bg-1)',
            border: 'none',
            borderRadius: 3,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setValue(initial ?? '');
            setEditing(false);
          }}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            background: 'transparent',
            color: 'var(--sf-fg-3)',
            border: '1px solid var(--sf-border-1)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
