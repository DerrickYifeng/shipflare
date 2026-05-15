'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
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

  return (
    <dialog
      ref={dialogRef}
      className="
        m-auto p-0 max-w-lg w-full
        bg-sf-bg-secondary
        rounded-[var(--radius-sf-lg)]
        shadow-[var(--shadow-sf-elevated)]
        backdrop:bg-black/40 backdrop:backdrop-blur-xl
        animate-sf-fade-in
      "
      aria-labelledby="dialog-title"
    >
      <div className="p-6">
        <h2
          id="dialog-title"
          className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-4"
        >
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
