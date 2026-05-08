'use client';

import { useEffect, useState, useCallback } from 'react';

interface HandoffClientProps {
  draftId: string;
  replyText: string;
  threadUrl: string;
  threadTitle: string;
  subreddit: string;
  author: string;
  alreadyHandedOff: boolean;
}

type Status = 'idle' | 'copied' | 'opened';

export function HandoffClient(props: HandoffClientProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [clipboardError, setClipboardError] = useState(false);

  const confirmHandoff = useCallback(async (): Promise<void> => {
    try {
      await fetch(`/api/draft/${props.draftId}/handoff-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      // Non-blocking — the user has already pressed the button. The server
      // will see another POST on subsequent interactions.
    }
  }, [props.draftId]);

  // Best-effort auto-copy. Some browsers require a user gesture; if the
  // attempt is denied, the Copy button still works on click.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await navigator.clipboard.writeText(props.replyText);
        if (!cancelled) setStatus('copied');
      } catch {
        if (!cancelled) setClipboardError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.replyText]);

  const onCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.replyText);
      setStatus('copied');
      setClipboardError(false);
      void confirmHandoff();
    } catch {
      setClipboardError(true);
    }
  }, [props.replyText, confirmHandoff]);

  // Critical write order: clipboard FIRST, then window.open. Safari and
  // Firefox cancel pending clipboard writes the moment focus leaves the
  // current document, so opening the new tab first would silently drop
  // the copy on those browsers.
  const onOpenThread = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.replyText);
      setStatus('opened');
      setClipboardError(false);
    } catch {
      setClipboardError(true);
    }
    void confirmHandoff();
    window.open(props.threadUrl, '_blank', 'noopener,noreferrer');
  }, [props.replyText, props.threadUrl, confirmHandoff]);

  const copyButtonLabel =
    status === 'copied' || status === 'opened' ? '✓ Copied' : 'Copy reply';

  return (
    <article className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Reply on Reddit</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {props.alreadyHandedOff
            ? 'You already handed off this reply. Re-copy below if you need to.'
            : "We can't post for you on Reddit. Three steps:"}
        </p>
      </header>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 1: Copy your reply
        </h2>
        <pre className="mt-2 max-h-96 overflow-y-auto rounded-md bg-muted p-4 font-mono text-sm whitespace-pre-wrap">
          {props.replyText}
        </pre>
        <button
          onClick={onCopy}
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          {copyButtonLabel}
        </button>
        {clipboardError && (
          <p className="mt-2 text-sm text-destructive">
            Clipboard access blocked. Click &ldquo;Copy reply&rdquo; to try again,
            or select the text above and copy with ⌘C / Ctrl+C.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 2: Open the Reddit thread
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          r/{props.subreddit} · u/{props.author} · {props.threadTitle}
        </p>
        <button
          onClick={onOpenThread}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary px-4 py-2"
        >
          Open Reddit thread ↗
        </button>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 3: Paste with ⌘V (Mac) or Ctrl+V (Windows / Linux), then click
          Reply on Reddit
        </h2>
      </section>

      <footer className="pt-4 border-t border-border">
        <a href="/today" className="text-sm text-muted-foreground underline">
          ← Back to /today
        </a>
      </footer>
    </article>
  );
}
