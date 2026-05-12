'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  joinWaitlist,
  type JoinWaitlistState,
} from '../actions';
import { type BannerVariant } from './context-banner';

const INITIAL: JoinWaitlistState = { ok: false };

export interface WaitlistFormProps {
  initialEmail: string;
  referer: BannerVariant;
}

export function WaitlistForm({ initialEmail, referer }: WaitlistFormProps) {
  const [state, formAction] = useActionState(joinWaitlist, INITIAL);

  if (state.ok) {
    return (
      <div
        style={{
          maxWidth: 480,
          margin: '0 auto 96px',
          padding: 32,
          background: 'var(--sf-bg-dark-surface)',
          borderRadius: 'var(--sf-radius-lg)',
          color: 'var(--sf-fg-on-dark-1)',
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: 'var(--sf-text-h2)',
            margin: '0 0 8px',
            fontWeight: 600,
          }}
        >
          You're on the list.
        </h2>
        <p style={{ color: 'var(--sf-fg-on-dark-2)', margin: '0 0 24px' }}>
          We'll email you when a slot opens.
        </p>
        <Link
          href="/"
          style={{
            color: 'var(--sf-accent)',
            textDecoration: 'underline',
          }}
        >
          ← Back to home
        </Link>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      style={{
        maxWidth: 480,
        margin: '0 auto 96px',
        padding: 32,
        background: 'var(--sf-bg-dark-surface)',
        borderRadius: 'var(--sf-radius-lg)',
        color: 'var(--sf-fg-on-dark-1)',
      }}
    >
      <label
        htmlFor="waitlist-email"
        style={{ display: 'block', fontSize: 14, marginBottom: 6 }}
      >
        Email
      </label>
      <input
        id="waitlist-email"
        name="email"
        type="email"
        required
        defaultValue={initialEmail}
        autoComplete="email"
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? 'waitlist-email-error' : undefined}
        style={inputStyle}
      />

      <label
        htmlFor="waitlist-usecase"
        style={{ display: 'block', fontSize: 14, marginTop: 16, marginBottom: 6 }}
      >
        What would you use ShipFlare for?{' '}
        <span style={{ color: 'var(--sf-fg-on-dark-3)' }}>(optional)</span>
      </label>
      <textarea
        id="waitlist-usecase"
        name="useCase"
        maxLength={500}
        rows={3}
        placeholder="A few words about what you'd like to ship faster."
        style={{ ...inputStyle, resize: 'vertical' }}
      />

      <input type="hidden" name="referer" value={referer} />

      {/* Honeypot — bots fill, humans don't see. */}
      <input
        name="company"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        style={{
          position: 'absolute',
          left: '-9999px',
          opacity: 0,
          pointerEvents: 'none',
          height: 0,
          width: 0,
        }}
      />

      {state.error ? (
        <p
          id="waitlist-email-error"
          role="alert"
          style={{
            color: 'var(--sf-error)',
            fontSize: 13,
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        marginTop: 20,
        width: '100%',
        minHeight: 44,
        background: 'var(--sf-accent)',
        color: 'var(--sf-fg-on-dark-1)',
        border: 'none',
        borderRadius: 'var(--sf-radius-md)',
        fontSize: 15,
        fontWeight: 600,
        cursor: pending ? 'wait' : 'pointer',
        opacity: pending ? 0.7 : 1,
      }}
    >
      {pending ? 'Sending…' : 'Request access'}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--sf-bg-dark)',
  color: 'var(--sf-fg-on-dark-1)',
  border: '1px solid var(--sf-border-on-dark)',
  borderRadius: 'var(--sf-radius-sm)',
  fontSize: 15,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
