'use client';

import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

/* =====================================================================
   ShipFlare v2 Toast
   ---------------------------------------------------------------------
   Bottom-center, glass-y, auto-dismisses at 5s with an optional
   undo affordance. Matches INTERACTIONS.md §7.
   Only one toast visible at a time — a new toast replaces the current.
   ===================================================================== */

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastWithActionOptions {
  message: string;
  variant?: ToastVariant;
  action: ToastAction;
  /** ms before auto-dismiss. Defaults to 5000. */
  timeoutMs?: number;
  /** Fires if the toast auto-dismisses without the action being clicked. */
  onTimeout?: () => void;
}

interface InternalToast {
  id: string;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
  timeoutMs: number;
  onTimeout?: () => void;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
  toastWithAction: (options: ToastWithActionOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
  toastWithAction: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const DEFAULT_TIMEOUT_MS = 5_000;

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `toast-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  // Replace-current behavior: only one toast slot at a time.
  const [current, setCurrent] = useState<InternalToast | null>(null);

  const dismiss = useCallback((id: string) => {
    setCurrent((prev) => (prev && prev.id === id ? null : prev));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = 'success') => {
    setCurrent({
      id: randomId(),
      message,
      variant,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }, []);

  const toastWithAction = useCallback((options: ToastWithActionOptions) => {
    setCurrent({
      id: randomId(),
      message: options.message,
      variant: options.variant ?? 'info',
      action: options.action,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onTimeout: options.onTimeout,
    });
  }, []);

  return (
    <ToastContext value={{ toast, toastWithAction }}>
      {children}
      <ToastViewport current={current} onDismiss={dismiss} />
    </ToastContext>
  );
}

const VIEWPORT_STYLE: CSSProperties = {
  position: 'fixed',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 'var(--sf-z-toast)' as unknown as number,
  pointerEvents: 'none',
  display: 'flex',
  justifyContent: 'center',
};

function ToastViewport({
  current,
  onDismiss,
}: {
  current: InternalToast | null;
  onDismiss: (id: string) => void;
}) {
  return (
    <div style={VIEWPORT_STYLE} aria-live="polite" aria-label="Notifications">
      {current ? <ToastItem toast={current} onDismiss={onDismiss} /> : null}
    </div>
  );
}

const VARIANT_ACCENT: Record<ToastVariant, string> = {
  success: 'var(--sf-success)',
  error: 'var(--sf-error)',
  warning: 'var(--sf-warning)',
  info: 'var(--sf-accent)',
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: InternalToast;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      toast.onTimeout?.();
      onDismiss(toast.id);
    }, toast.timeoutMs);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const handleAction = () => {
    toast.action?.onClick();
    onDismiss(toast.id);
  };

  const handleClose = () => {
    onDismiss(toast.id);
  };

  const shellStyle: CSSProperties = {
    pointerEvents: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 14,
    minHeight: 44,
    padding: '10px 16px 10px 14px',
    borderRadius: 'var(--sf-radius-pill)',
    background: 'var(--sf-bg-dark)',
    color: 'var(--sf-fg-on-dark-1)',
    fontSize: 'var(--sf-text-sm)',
    fontWeight: 500,
    letterSpacing: 'var(--sf-track-normal)',
    boxShadow: 'var(--sf-shadow-elevated)',
    animation: 'sf-slide-up var(--sf-dur-base) var(--sf-ease-swift)',
  };

  const dotStyle: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: VARIANT_ACCENT[toast.variant],
    flexShrink: 0,
  };

  const actionStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--sf-link-dark)',
    fontSize: 'var(--sf-text-sm)',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '0 4px',
    fontFamily: 'inherit',
  };

  const closeStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--sf-fg-on-dark-3)',
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '0 4px',
    fontFamily: 'inherit',
  };

  return (
    <div role="alert" style={shellStyle}>
      <span style={dotStyle} aria-hidden="true" />
      <span>{toast.message}</span>
      {toast.action ? (
        <button type="button" onClick={handleAction} style={actionStyle}>
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" onClick={handleClose} style={closeStyle} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
