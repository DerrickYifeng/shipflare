'use client';

import { useEffect, useRef } from 'react';

export interface ShortcutBinding {
  keys: string;
  label: string;
}

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
  bindings: ShortcutBinding[];
}

/**
 * Help overlay listing available keyboard shortcuts.
 *
 * Mirrors the `AlertDialog` pattern — native `<dialog>` for focus trap,
 * backdrop, and Escape-to-dismiss without extra deps.
 */
export function ShortcutsHelp({ open, onClose, bindings }: ShortcutsHelpProps) {
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
        m-auto p-0 max-w-md w-full
        bg-sf-bg-secondary
        rounded-[var(--radius-sf-lg)]
        shadow-[var(--shadow-sf-elevated)]
        backdrop:bg-black/40 backdrop:backdrop-blur-xl
        animate-sf-fade-in
      "
      aria-labelledby="shortcuts-help-title"
    >
      <div className="p-6">
        <h2
          id="shortcuts-help-title"
          className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-4"
        >
          Keyboard shortcuts
        </h2>
        <ul className="flex flex-col gap-2 mb-6">
          {bindings.map((b) => (
            <li
              key={b.keys}
              className="flex items-center justify-between text-[14px] tracking-[-0.224px] text-sf-text-secondary"
            >
              <span>{b.label}</span>
              <kbd className="font-mono text-[12px] tracking-[-0.12px] bg-[#f5f5f7] border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-sm)] px-2 py-0.5 text-sf-text-primary">
                {b.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] tracking-[-0.224px] text-sf-text-secondary hover:text-sf-text-primary transition-colors duration-200"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
