'use client';

import { useState, useTransition } from 'react';
import { addInvite } from '../actions';

/**
 * Add-invite form. Single email input + optional note. Pending state
 * shown via `useTransition` so the button disables while the action
 * roundtrips.
 */
export function InviteForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await addInvite(fd);
          if (result.ok) {
            setEmail('');
            setNote('');
          } else {
            setError(result.error);
          }
        });
      }}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        marginBottom: 20,
      }}
    >
      <input
        type="email"
        name="email"
        placeholder="partner@example.com"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{
          flex: '1 1 240px',
          padding: '8px 12px',
          fontSize: 13,
          background: 'var(--sf-bg-1)',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 4,
          color: 'var(--sf-fg-1)',
        }}
      />
      <input
        type="text"
        name="note"
        placeholder="note (e.g. YC dinner, wants LinkedIn)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        style={{
          flex: '2 1 320px',
          padding: '8px 12px',
          fontSize: 13,
          background: 'var(--sf-bg-1)',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 4,
          color: 'var(--sf-fg-1)',
        }}
      />
      <button
        type="submit"
        disabled={pending}
        style={{
          padding: '8px 16px',
          fontSize: 13,
          background: pending ? 'var(--sf-bg-2)' : 'var(--sf-fg-1)',
          color: pending ? 'var(--sf-fg-3)' : 'var(--sf-bg-1)',
          border: 'none',
          borderRadius: 4,
          cursor: pending ? 'wait' : 'pointer',
          fontWeight: 500,
        }}
      >
        {pending ? 'Adding…' : 'Add invite'}
      </button>
      {error ? (
        <div
          role="alert"
          style={{
            flexBasis: '100%',
            color: 'var(--sf-status-error, #c0392b)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}
    </form>
  );
}
