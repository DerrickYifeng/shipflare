'use client';

import { useTransition } from 'react';
import { revokeInvite } from '../actions';

/**
 * Per-row revoke button. Uses a confirm() prompt so a stray click
 * doesn't kick out an active partner.
 */
export function RevokeButton({ email }: { email: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Revoke invite for ${email}? Active sessions will be terminated.`)) {
          return;
        }
        const fd = new FormData();
        fd.set('email', email);
        startTransition(async () => {
          const result = await revokeInvite(fd);
          if (!result.ok) {
            window.alert(`Revoke failed: ${result.error}`);
          }
        });
      }}
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: 'transparent',
        color: 'var(--sf-status-error, #c0392b)',
        border: '1px solid currentColor',
        borderRadius: 3,
        cursor: pending ? 'wait' : 'pointer',
      }}
    >
      {pending ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
