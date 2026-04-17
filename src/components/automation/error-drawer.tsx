'use client';

import { useEffect, useRef } from 'react';
import type { AgentErrorEntry } from '@/hooks/agent-stream-provider';
import { Button } from '@/components/ui/button';

interface ErrorDrawerProps {
  open: boolean;
  error: AgentErrorEntry | null;
  onClose: () => void;
}

/**
 * Right-side drawer that surfaces the full payload of an error SSE event.
 *
 * Built on the native `<dialog>` element for the same reasons as
 * `components/ui/alert-dialog.tsx`: focus trap, Escape-to-close, backdrop,
 * all for free. We position it flush-right (instead of centered) and
 * animate it in from the edge.
 */
export function ErrorDrawer({ open, error, onClose }: ErrorDrawerProps) {
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
        ml-auto mr-0 my-0 p-0 max-w-md w-full h-screen
        bg-sf-bg-secondary
        rounded-none
        shadow-[var(--shadow-sf-elevated)]
        backdrop:bg-black/40 backdrop:backdrop-blur-xl
        animate-sf-fade-in
      "
      aria-labelledby="error-drawer-title"
    >
      <div className="flex flex-col h-full">
        <div className="px-6 py-4 border-b border-sf-divider flex items-center justify-between">
          <h2
            id="error-drawer-title"
            className="text-[17px] font-semibold text-sf-text-primary tracking-[-0.374px]"
          >
            Agent error
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        {error ? (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <Field label="Message" value={error.message} mono />
            {error.processor && <Field label="Processor" value={error.processor} />}
            {error.traceId && <Field label="Trace id" value={error.traceId} mono />}
            <Field
              label="Timestamp"
              value={new Date(error.timestamp).toISOString()}
            />

            <div>
              <div className="text-[12px] uppercase tracking-[0.5px] text-sf-text-tertiary mb-1">
                Full payload
              </div>
              <pre className="text-[12px] leading-[1.47] text-sf-text-primary bg-sf-bg-primary rounded-[var(--radius-sf-md)] p-3 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(error.payload, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[14px] text-sf-text-tertiary">
            No error selected.
          </div>
        )}
      </div>
    </dialog>
  );
}

interface FieldProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Field({ label, value, mono = false }: FieldProps) {
  return (
    <div>
      <div className="text-[12px] uppercase tracking-[0.5px] text-sf-text-tertiary mb-1">
        {label}
      </div>
      <div
        className={`text-[14px] text-sf-text-primary break-words ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
