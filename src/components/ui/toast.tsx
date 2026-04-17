'use client';

import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
  timeoutMs: number;
  onTimeout?: () => void;
}

interface ToastWithActionOptions {
  message: string;
  variant?: ToastVariant;
  action: ToastAction;
  /** How long the toast stays visible before auto-dismiss (also fires onTimeout). */
  timeoutMs?: number;
  /** Fires when the toast auto-dismisses without the action being clicked. */
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

const DEFAULT_TIMEOUT_MS = 4_000;

const variantStyles: Record<ToastVariant, string> = {
  success: 'bg-sf-success text-white',
  error: 'bg-sf-error text-white',
  warning: 'bg-sf-warning text-white',
  info: 'bg-sf-accent text-white',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = 'success') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [
      ...prev,
      { id, message, variant, timeoutMs: DEFAULT_TIMEOUT_MS },
    ]);
  }, []);

  const toastWithAction = useCallback((options: ToastWithActionOptions) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [
      ...prev,
      {
        id,
        message: options.message,
        variant: options.variant ?? 'info',
        action: options.action,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onTimeout: options.onTimeout,
      },
    ]);
  }, []);

  return (
    <ToastContext value={{ toast, toastWithAction }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      t.onTimeout?.();
      onDismiss(t.id);
    }, t.timeoutMs);
    return () => clearTimeout(timer);
  }, [t, onDismiss]);

  const handleAction = () => {
    t.action?.onClick();
    onDismiss(t.id);
  };

  return (
    <div
      className={`
        animate-sf-slide-up
        flex items-center gap-3
        px-4 py-3 rounded-[var(--radius-sf-lg)]
        text-[14px] font-medium tracking-[-0.224px]
        shadow-[var(--shadow-sf-elevated)]
        backdrop-blur-xl
        ${variantStyles[t.variant]}
      `}
      role="alert"
    >
      <span>{t.message}</span>
      {t.action && (
        <button
          type="button"
          onClick={handleAction}
          className="text-[13px] font-semibold underline underline-offset-2 hover:opacity-90 transition-opacity"
        >
          {t.action.label}
        </button>
      )}
    </div>
  );
}
