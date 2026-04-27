'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './button';

interface AlertDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Disables the confirm button (e.g. while an async action runs). */
  confirmDisabled?: boolean;
}

/**
 * Replacement for `window.confirm()` / `alert()`.
 *
 * Built on the native <dialog> element (same primitive Dialog uses) so we get
 * focus trapping, Escape-to-dismiss and backdrop styling for free.
 */
export function AlertDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirmDisabled = false,
}: AlertDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const handleConfirm = () => {
    onConfirm();
  };

  return (
    <dialog
      ref={dialogRef}
      className="
        m-auto p-0 max-w-md w-full
        bg-sf-bg-secondary
        rounded-[var(--radius-sf-lg)]
        shadow-[var(--shadow-sf-elevated)]
        backdrop:bg-black/40 backdrop:backdrop-blur-xl
        animate-sf-fade-in
      "
      aria-labelledby="alert-dialog-title"
      aria-describedby={description ? 'alert-dialog-description' : undefined}
      role="alertdialog"
    >
      <div className="p-6">
        <h2
          id="alert-dialog-title"
          className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-2"
        >
          {title}
        </h2>
        {description && (
          <div
            id="alert-dialog-description"
            className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-[1.47] mb-6"
          >
            {description}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'error' : 'primary'}
            onClick={handleConfirm}
            disabled={confirmDisabled}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
