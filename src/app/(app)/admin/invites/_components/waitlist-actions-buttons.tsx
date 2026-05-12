'use client';

import { useTransition } from 'react';
import { approveWaitlistSignup, dismissWaitlistSignup } from '../actions';

export function WaitlistActionsButtons({ id }: { id: string }) {
  const [pending, start] = useTransition();

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => approveWaitlistSignup(id).then(() => {}))}
        style={{
          padding: '4px 10px',
          background: 'var(--sf-accent)',
          color: 'var(--sf-fg-on-dark-1)',
          border: 'none',
          borderRadius: 4,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.7 : 1,
        }}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => dismissWaitlistSignup(id).then(() => {}))}
        style={{
          padding: '4px 10px',
          background: 'transparent',
          color: 'var(--sf-fg-3)',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 4,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
