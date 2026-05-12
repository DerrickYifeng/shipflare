'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { signInWithGitHub, signInWithGoogle } from '@/app/actions/auth';

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  onBeforeSignIn?: () => void;
}

interface Provider {
  id: 'github' | 'google';
  label: string;
  icon: ReactNode;
  action: () => Promise<void>;
  /** Visual variant — picks which surface tokens the button uses. */
  variant: 'dark' | 'light';
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function GoogleIcon() {
  // Standard 4-color "G" mark. Path data from Google's official brand asset.
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M19.6 10.23c0-.68-.06-1.34-.18-1.97H10v3.73h5.39a4.6 4.6 0 0 1-2 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.29z"
      />
      <path
        fill="#34A853"
        d="M10 20c2.7 0 4.96-.9 6.62-2.43l-3.23-2.51c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H1.06v2.59A9.99 9.99 0 0 0 10 20z"
      />
      <path
        fill="#FBBC05"
        d="M4.4 11.9a6 6 0 0 1 0-3.8V5.51H1.06a10 10 0 0 0 0 8.98L4.4 11.9z"
      />
      <path
        fill="#EA4335"
        d="M10 3.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87C14.96.99 12.7 0 10 0A9.99 9.99 0 0 0 1.06 5.51L4.4 8.1C5.19 5.74 7.4 3.96 10 3.96z"
      />
    </svg>
  );
}

const VARIANT_STYLES = {
  dark: {
    background: 'var(--sf-bg-dark)',
    hoverBackground: 'var(--sf-bg-dark-surface)',
    color: 'var(--sf-fg-on-dark-1)',
    border: 'none',
  },
  light: {
    background: 'var(--sf-bg-primary)',
    hoverBackground: 'var(--sf-bg-secondary)',
    color: 'var(--sf-fg-1)',
    border: '1px solid var(--sf-border-subtle)',
  },
} as const;

const PROVIDERS: Provider[] = [
  // Google first: friction-reduction is the goal, so lead with the
  // broader-reach option. See docs/superpowers/specs/2026-05-11-google-auth-design.md.
  {
    id: 'google',
    label: 'Continue with Google',
    icon: <GoogleIcon />,
    action: signInWithGoogle,
    variant: 'light',
  },
  {
    id: 'github',
    label: 'Continue with GitHub',
    icon: <GitHubIcon />,
    action: signInWithGitHub,
    variant: 'dark',
  },
];

export function SignInModal({ open, onClose, onBeforeSignIn }: SignInModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === ref.current) {
      ref.current?.close();
    }
  }

  return (
    <dialog
      ref={ref}
      onClick={handleBackdropClick}
      aria-labelledby="sign-in-modal-title"
      className="m-auto w-[calc(100%-2rem)] max-w-[400px] p-0 backdrop:bg-black/40 animate-sf-fade-in"
      style={{
        background: 'var(--sf-bg-secondary)',
        color: 'var(--sf-fg-1)',
        borderRadius: 'var(--sf-radius-lg)',
        boxShadow: 'var(--sf-shadow-elevated)',
        border: '1px solid var(--sf-border-subtle)',
      }}
    >
      <div style={{ padding: 24 }}>
        <div className="flex items-start justify-between" style={{ marginBottom: 4 }}>
          <h2
            id="sign-in-modal-title"
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-h3)',
              fontWeight: 600,
              letterSpacing: 'var(--sf-track-tight)',
              color: 'var(--sf-fg-1)',
            }}
          >
            Sign in to ShipFlare
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            style={{
              marginRight: -8,
              marginTop: -4,
              padding: 8,
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              color: 'var(--sf-fg-3)',
              transition: 'color var(--sf-dur-base) var(--sf-ease-swift)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--sf-fg-1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--sf-fg-3)';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z" />
            </svg>
          </button>
        </div>
        <p
          style={{
            marginTop: 0,
            marginBottom: 20,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-2)',
            letterSpacing: 'var(--sf-track-normal)',
          }}
        >
          Choose how you want to sign in.
        </p>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {PROVIDERS.map((provider) => (
            <form key={provider.id} action={provider.action}>
              <button
                type="submit"
                onClick={() => onBeforeSignIn?.()}
                className="w-full flex items-center justify-center"
                style={{
                  gap: 10,
                  minHeight: 44,
                  padding: '10px 20px',
                  background: VARIANT_STYLES[provider.variant].background,
                  color: VARIANT_STYLES[provider.variant].color,
                  borderRadius: 'var(--sf-radius-md)',
                  border: VARIANT_STYLES[provider.variant].border,
                  fontSize: 'var(--sf-text-base)',
                  fontWeight: 500,
                  letterSpacing: 'var(--sf-track-tight)',
                  cursor: 'pointer',
                  transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    VARIANT_STYLES[provider.variant].hoverBackground;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background =
                    VARIANT_STYLES[provider.variant].background;
                }}
              >
                {provider.icon}
                {provider.label}
              </button>
            </form>
          ))}
        </div>
      </div>
    </dialog>
  );
}
