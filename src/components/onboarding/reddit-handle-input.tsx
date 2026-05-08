'use client';

import { useState, useCallback } from 'react';

interface RedditHandleInputProps {
  initialHandle?: string;
  onSubmit: (handle: string) => void | Promise<void>;
}

type VerifyState =
  | { phase: 'idle' }
  | { phase: 'verifying' }
  | { phase: 'verified'; karma: number }
  | { phase: 'not_found' }
  | { phase: 'unavailable' };

export function RedditHandleInput({
  initialHandle = '',
  onSubmit,
}: RedditHandleInputProps) {
  const [handle, setHandle] = useState(initialHandle);
  const [verifyState, setVerifyState] = useState<VerifyState>({ phase: 'idle' });
  const [softBlockOpen, setSoftBlockOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onVerify = useCallback(async () => {
    if (!handle.trim()) return;
    setVerifyState({ phase: 'verifying' });
    try {
      const res = await fetch('/api/reddit/verify-handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      const json = (await res.json()) as
        | { exists: true; karma: number }
        | { exists: false }
        | { exists: null; error: string };
      if (json.exists === true) {
        setVerifyState({ phase: 'verified', karma: json.karma });
      } else if (json.exists === false) {
        setVerifyState({ phase: 'not_found' });
      } else {
        setVerifyState({ phase: 'unavailable' });
      }
    } catch {
      setVerifyState({ phase: 'unavailable' });
    }
  }, [handle]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(handle);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Could not save handle.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [handle, onSubmit]);

  const onConnect = useCallback(() => {
    if (verifyState.phase === 'verified') {
      void submit();
      return;
    }
    if (verifyState.phase === 'not_found') {
      setSoftBlockOpen(true);
      return;
    }
    void submit();
  }, [verifyState, submit]);

  const onContinueAnyway = useCallback(() => {
    setSoftBlockOpen(false);
    void submit();
  }, [submit]);

  return (
    <div className="space-y-4">
      <label htmlFor="reddit-handle" className="block text-sm font-medium">
        Your Reddit username
      </label>
      <div className="flex gap-2">
        <span className="flex items-center px-2 text-muted-foreground">u/</span>
        <input
          id="reddit-handle"
          type="text"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value.replace(/^\/?u\//i, ''));
            setVerifyState({ phase: 'idle' });
            setSubmitError(null);
          }}
          placeholder="founder123"
          className="flex-1 rounded-md border border-input px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={onVerify}
          disabled={!handle.trim() || verifyState.phase === 'verifying'}
          className="rounded-md border border-input px-4 py-2 text-sm"
        >
          {verifyState.phase === 'verifying' ? 'Checking…' : 'Verify'}
        </button>
      </div>

      {verifyState.phase === 'verified' && (
        <p className="text-sm text-success">
          Verified — u/{handle} has {verifyState.karma.toLocaleString()} karma.
        </p>
      )}
      {verifyState.phase === 'not_found' && (
        <p className="text-sm text-warning">
          We couldn&apos;t find u/{handle}. Double-check the spelling, or
          continue anyway if you&apos;re sure.
        </p>
      )}
      {verifyState.phase === 'unavailable' && (
        <p className="text-sm text-muted-foreground">
          Reddit is rate-limiting us right now — we couldn&apos;t verify the
          handle. You can continue.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        ⓘ We never post for you. You&apos;ll click through to Reddit yourself
        to post each draft.
      </p>

      <button
        type="button"
        onClick={onConnect}
        disabled={!handle.trim() || submitting}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
      >
        {submitting ? 'Saving…' : 'Connect'}
      </button>

      {submitError && (
        <p role="alert" className="text-sm text-error">
          {submitError}
        </p>
      )}

      {softBlockOpen && (
        <div
          role="dialog"
          className="mt-4 rounded-md border border-warning bg-warning/10 p-4"
        >
          <p className="text-sm">
            We couldn&apos;t confirm u/{handle} exists. Are you sure?
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onContinueAnyway}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            >
              Continue anyway
            </button>
            <button
              type="button"
              onClick={() => setSoftBlockOpen(false)}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              Edit handle
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
