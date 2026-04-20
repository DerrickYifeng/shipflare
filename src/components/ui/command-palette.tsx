'use client';

/**
 * Command palette — scaffold for INTERACTIONS.md §11 (⌘K).
 *
 * Minimum viable: centered modal on `--sf-paper-raised`, single search
 * input, Escape closes, focus trapped by the native `<dialog>` element.
 * No real commands wired yet; the empty-state copy tells the user the
 * feature is coming.
 *
 * Mounted by `AppShell`; toggled by a ⌘K / Ctrl+K listener also in
 * AppShell. That keeps the keyboard binding available on every
 * authenticated route without each page re-implementing it.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const BACKDROP_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  maxWidth: 'none',
  maxHeight: 'none',
  width: '100%',
  height: '100%',
  margin: 0,
  inset: 0,
};

const PANEL_STYLE: CSSProperties = {
  width: 'min(560px, calc(100vw - 32px))',
  margin: '12vh auto 0',
  background: 'var(--sf-paper-raised)',
  border: '1px solid var(--sf-border-subtle)',
  borderRadius: 'var(--sf-radius-lg)',
  boxShadow:
    '0 24px 48px oklch(14% 0.020 265 / 0.24), 0 2px 8px oklch(14% 0.020 265 / 0.10)',
  overflow: 'hidden',
};

const INPUT_WRAPPER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '14px 16px',
  borderBottom: '1px solid var(--sf-border-subtle)',
};

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontSize: 'var(--sf-text-base)',
  color: 'var(--sf-fg-1)',
  letterSpacing: 'var(--sf-track-normal)',
  fontFamily: 'inherit',
};

const EMPTY_STATE_STYLE: CSSProperties = {
  padding: '28px 16px 24px',
  textAlign: 'center',
  color: 'var(--sf-fg-3)',
  fontSize: 'var(--sf-text-sm)',
  letterSpacing: 'var(--sf-track-normal)',
  lineHeight: 1.5,
};

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 16px',
  borderTop: '1px solid var(--sf-border-subtle)',
  background: 'var(--sf-paper-sunken)',
  color: 'var(--sf-fg-3)',
};

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  // Open / close the native <dialog> in sync with the `open` prop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Defer so the input is mounted before focus is attempted.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Bridge the native `close` event (Escape, click-outside) to the parent.
  // Resetting the query here (rather than in a dedicated `open` effect)
  // keeps all state mutations outside of effect bodies, satisfying
  // `react-hooks/set-state-in-effect`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = (): void => {
      setQuery('');
      onClose();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  // Click on the backdrop closes.
  const onBackdropClick = (event: React.MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="cmdk-title"
      onClick={onBackdropClick}
      style={BACKDROP_STYLE}
    >
      <div style={PANEL_STYLE} role="document">
        <div style={INPUT_WRAPPER_STYLE}>
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands…"
            aria-label="Search commands"
            style={INPUT_STYLE}
          />
          <kbd
            className="sf-mono"
            aria-hidden="true"
            style={{
              fontSize: 'var(--sf-text-2xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-mono)',
              border: '1px solid var(--sf-border-subtle)',
              borderRadius: 'var(--sf-radius-sm)',
              padding: '2px 6px',
              background: 'var(--sf-paper-sunken)',
            }}
          >
            ESC
          </kbd>
        </div>

        <h2 id="cmdk-title" className="sr-only">
          Command palette
        </h2>

        <div style={EMPTY_STATE_STYLE}>
          Coming soon — ⌘K will search commands and jump routes in a future release.
        </div>

        <div style={FOOTER_STYLE}>
          <span
            className="sf-mono"
            style={{
              fontSize: 'var(--sf-text-2xs)',
              letterSpacing: 'var(--sf-track-mono)',
            }}
          >
            COMMAND PALETTE
          </span>
          <span
            className="sf-mono"
            style={{
              fontSize: 'var(--sf-text-2xs)',
              letterSpacing: 'var(--sf-track-mono)',
            }}
          >
            PREVIEW
          </span>
        </div>
      </div>
    </dialog>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      style={{ color: 'var(--sf-fg-3)', flexShrink: 0 }}
    >
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11l3 3" strokeLinecap="round" />
    </svg>
  );
}
