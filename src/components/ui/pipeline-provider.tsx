'use client';

import {
  useState,
  useCallback,
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from 'react';

interface PipelineOperation {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  error?: string;
}

interface PipelineContextValue {
  operations: PipelineOperation[];
  run: (id: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
  isRunning: (id: string) => boolean;
  hasRunning: boolean;
}

const PipelineContext = createContext<PipelineContextValue>({
  operations: [],
  run: async () => {},
  isRunning: () => false,
  hasRunning: false,
});

export function usePipeline() {
  return useContext(PipelineContext);
}

const DONE_LINGER_MS = 3_000;

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<PipelineOperation[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const run = useCallback(
    async (id: string, label: string, fn: () => Promise<unknown>) => {
      // Clear any pending cleanup timer for this id
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);

      setOperations((prev) => {
        const without = prev.filter((op) => op.id !== id);
        return [...without, { id, label, status: 'running', startedAt: Date.now() }];
      });

      try {
        await fn();
        setOperations((prev) =>
          prev.map((op) => (op.id === id ? { ...op, status: 'done' } : op)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed';
        setOperations((prev) =>
          prev.map((op) =>
            op.id === id ? { ...op, status: 'error', error: message } : op,
          ),
        );
        throw err;
      } finally {
        // Auto-remove after linger period
        const timer = setTimeout(() => {
          setOperations((prev) => prev.filter((op) => op.id !== id));
          timersRef.current.delete(id);
        }, DONE_LINGER_MS);
        timersRef.current.set(id, timer);
      }
    },
    [],
  );

  const isRunning = useCallback(
    (id: string) => operations.some((op) => op.id === id && op.status === 'running'),
    [operations],
  );

  const hasRunning = operations.some((op) => op.status === 'running');

  return (
    <PipelineContext value={{ operations, run, isRunning, hasRunning }}>
      {children}
      {operations.length > 0 && <PipelineBanner operations={operations} />}
    </PipelineContext>
  );
}

function PipelineBanner({ operations }: { operations: PipelineOperation[] }) {
  const running = operations.filter((op) => op.status === 'running');
  const done = operations.filter((op) => op.status === 'done');
  const errored = operations.filter((op) => op.status === 'error');

  if (running.length === 0 && done.length === 0 && errored.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex flex-col gap-1.5 max-w-[280px]"
      aria-live="polite"
      aria-label="Pipeline status"
    >
      {running.map((op) => (
        <div
          key={op.id}
          className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[var(--radius-sf-md)] bg-sf-bg-secondary border border-sf-border shadow-lg animate-sf-fade-in"
        >
          <Spinner />
          <span className="text-[12px] font-medium text-sf-text-secondary">{op.label}</span>
        </div>
      ))}
      {done.map((op) => (
        <div
          key={op.id}
          className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[var(--radius-sf-md)] bg-sf-success/10 border border-sf-success/20 shadow-lg animate-sf-fade-in"
        >
          <CheckIcon />
          <span className="text-[12px] font-medium text-sf-success">{op.label} — done</span>
        </div>
      ))}
      {errored.map((op) => (
        <div
          key={op.id}
          className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[var(--radius-sf-md)] bg-sf-error/10 border border-sf-error/20 shadow-lg animate-sf-fade-in"
        >
          <ErrorIcon />
          <span className="text-[12px] font-medium text-sf-error">{op.error ?? 'Failed'}</span>
        </div>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="animate-spin flex-shrink-0"
    >
      <circle cx="7" cy="7" r="5.5" stroke="var(--color-sf-border)" strokeWidth="1.5" />
      <path
        d="M12.5 7a5.5 5.5 0 0 0-5.5-5.5"
        stroke="var(--color-sf-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
      <path d="M3 7.5l2.5 2.5 5.5-6" stroke="var(--color-sf-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
      <path d="M4 4l6 6M10 4l-6 6" stroke="var(--color-sf-error)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
