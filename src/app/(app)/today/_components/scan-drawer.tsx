'use client';

/**
 * ShipFlare v2 — ScanDrawer
 *
 * Cinematic "observation window" that slides down over the main content
 * when the user clicks Scan now. Signature interaction — per INTERACTIONS
 * §4. Does NOT own the scan worker: it's a view on top of live BullMQ
 * state exposed via `useScanFlow`.
 *
 * Contract:
 *  - `open` controls visibility only. Worker keeps running when closed.
 *  - `thoughtIdx` comes from the real source chip states (0..4).
 *  - `url` is a display string, e.g. the user's website — purely cosmetic.
 *  - `phase` is derived from `thoughtIdx` and `isRunning`.
 *
 * Escape closes the drawer but does not abort the scan.
 */

import {
  type CSSProperties,
  useEffect,
  useState,
} from 'react';
import { Ops } from '@/components/ui/ops';
import { StatusDot } from '@/components/ui/status-dot';
import { ThoughtStream, type ThoughtStep } from '@/components/ui/thought-stream';

interface ScanDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Cosmetic URL that types out during the typing phase. */
  url?: string;
  /** 0..5 — owned by useScanFlow. */
  thoughtIdx: number;
  /** True while the BullMQ pipeline still has sources in flight. */
  isRunning: boolean;
}

/**
 * Five-beat cinematic scan narrative. The "Adversarial review" step is the
 * tonal payoff — it fires after most sources have returned but before drafts
 * surface. Ported verbatim from design_handoff/source/app/motion.jsx:13-19.
 */
const SCAN_STEPS: ThoughtStep[] = [
  {
    label: 'Reading your product',
    detail: 'Product description · voice profile · banned phrases',
  },
  {
    label: 'Querying sources',
    detail: 'Scanning connected communities for active discussions',
  },
  {
    label: 'Ranking by intent',
    detail: 'Asking > venting > discussing — highest-signal first',
  },
  {
    label: 'Adversarial review',
    detail: 'Checking tone, FTC disclosure, voice-profile drift',
  },
  {
    label: 'Surfacing to your queue',
    detail: 'Drafting replies and revealing them on Today',
  },
];

const DEFAULT_URL = 'linear.app';

type Phase = 'idle' | 'typing' | 'thinking' | 'done';

/**
 * Extra buffer after the last typed char before we flip to "thinking".
 * Sourced from motion.jsx — the 280ms beat gives the cursor one last blink
 * before the scanning pill takes over.
 */
const TYPING_TRAIL_MS = 280;

export function ScanDrawer({
  open,
  onClose,
  url = DEFAULT_URL,
  thoughtIdx,
  isRunning,
}: ScanDrawerProps) {
  // Explicit phase state machine, mirroring motion.jsx:32-53.
  //
  //   closed  → 'idle'
  //   open    → 'typing' for (60ms * url.length + 280ms)
  //                      → 'thinking' while isRunning / thoughtIdx < 5
  //                      → 'done' once all beats complete and worker quiesced
  //
  // We intentionally avoid calling setState synchronously in an effect body
  // (see the repo-wide react-hooks/set-state-in-effect rule). Instead,
  // `typingDoneKey` is only ever written from inside a setTimeout callback,
  // and a render-time `key !== openKey` comparison handles the reset when
  // the drawer closes or URL changes — no effect-time setState required.
  const openKey = `${open ? 1 : 0}:${url}`;
  const [typingDoneKey, setTypingDoneKey] = useState<string | null>(null);
  // When the key drifts (close / url change), the stored latch is stale
  // and typing must re-run. Treat a stale key as "not yet done".
  const typingDone = open && typingDoneKey === openKey;

  useEffect(() => {
    if (!open) return;
    // If the latch is already for this open cycle, nothing to schedule.
    if (typingDoneKey === openKey) return;
    const typingMs = 60 * url.length + TYPING_TRAIL_MS;
    const t = setTimeout(() => {
      setTypingDoneKey(openKey);
    }, typingMs);
    return () => clearTimeout(t);
  }, [open, url, openKey, typingDoneKey]);

  // Synchronous phase derivation — no setState-in-effect. Guarantees the
  // URL caret blinks *only* during the literal typing beat and flips to
  // "done" exactly when the worker quiesces after every beat ticks over.
  const phase: Phase = !open
    ? 'idle'
    : !typingDone
      ? 'typing'
      : !isRunning && thoughtIdx >= SCAN_STEPS.length
        ? 'done'
        : 'thinking';

  // Escape-to-close. Keyboard handler intentionally does NOT abort the
  // underlying BullMQ scan — only the drawer visibility.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Cosmetic: type the URL out over ~60ms per char once the drawer opens.
  const typedUrl = useTypedString(url, open);

  const outerStyle: CSSProperties = {
    maxHeight: open ? 560 : 0,
    overflow: 'hidden',
    transition:
      'max-height var(--sf-dur-slow) var(--sf-ease-swift), margin var(--sf-dur-slow) var(--sf-ease-swift)',
    marginBottom: open ? 20 : 0,
    padding: open ? '0 clamp(16px, 3vw, 32px)' : '0 clamp(16px, 3vw, 32px)',
  };

  return (
    <div style={outerStyle} aria-hidden={!open}>
      <div
        role="dialog"
        aria-modal="false"
        aria-label="Discovery scan in progress"
        style={{
          borderRadius: 'var(--sf-radius-lg)',
          background: 'var(--sf-bg-dark)',
          border: '1px solid var(--sf-border-on-dark)',
          boxShadow: 'var(--sf-shadow-elevated)',
          overflow: 'hidden',
        }}
      >
        <DrawerChrome phase={phase} onClose={onClose} />
        <DrawerUrlRow typed={typedUrl} phase={phase} />
        <div style={{ padding: '18px 18px 22px', minHeight: 220 }}>
          <ThoughtStream
            steps={SCAN_STEPS}
            activeIdx={Math.max(0, Math.min(thoughtIdx, SCAN_STEPS.length))}
            onDark
            header="Live scan"
          />
        </div>
      </div>
    </div>
  );
}

/* ── Chrome row (traffic lights + live status) ─────────────────────── */

function DrawerChrome({
  phase,
  onClose,
}: {
  phase: Phase;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--sf-border-on-dark)',
        background: 'oklch(22% 0.012 260)',
      }}
    >
      <Dot color="var(--sf-error)" />
      <Dot color="var(--sf-warning)" />
      <Dot color="var(--sf-success)" />
      <Ops tone="onDark" style={{ marginLeft: 14 }}>
        shipflare · scan · live
      </Ops>
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <StatusDot
          state={phase === 'done' ? 'success' : 'active'}
          size={6}
        />
        <Ops tone="onDark">
          {phase === 'done' ? 'complete' : 'agent live'}
        </Ops>
        <button
          type="button"
          onClick={onClose}
          aria-label="Minimize scan drawer"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--sf-fg-on-dark-3)',
            fontSize: 14,
            marginLeft: 8,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
      }}
    />
  );
}

/* ── URL row (typed readout + status pill) ─────────────────────────── */

function DrawerUrlRow({ typed, phase }: { typed: string; phase: Phase }) {
  const pillStyle: CSSProperties = {
    padding: '6px 12px',
    borderRadius: 'var(--sf-radius-md)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 'var(--sf-text-xs)',
    textTransform: 'uppercase',
    letterSpacing: 'var(--sf-track-mono)',
    fontWeight: 600,
    background:
      phase === 'done'
        ? 'var(--sf-success-light)'
        : 'var(--sf-accent-light)',
    color:
      phase === 'done'
        ? 'var(--sf-success-ink)'
        : 'var(--sf-link)',
  };

  return (
    <div
      style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--sf-border-on-dark)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          background: 'oklch(16% 0.012 260)',
          border: '1px solid var(--sf-border-on-dark)',
          borderRadius: 'var(--sf-radius-md)',
          padding: '8px 12px',
          fontFamily: 'var(--sf-font-mono)',
          fontSize: 'var(--sf-text-sm)',
          color: 'var(--sf-fg-on-dark-1)',
          minWidth: 0,
        }}
      >
        <span
          style={{ color: 'var(--sf-fg-on-dark-4)', marginRight: 6 }}
        >
          https://
        </span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {typed}
        </span>
        {phase === 'typing' && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 1.5,
              height: 13,
              background: 'var(--sf-fg-on-dark-1)',
              marginLeft: 2,
              animation: 'sfCaret 1s step-end infinite',
            }}
          />
        )}
      </div>
      <span style={pillStyle}>
        {phase === 'thinking'
          ? 'scanning'
          : phase === 'done'
            ? 'done'
            : 'ready'}
      </span>
      <style>{`@keyframes sfCaret { 0%,49% { opacity:1 } 50%,100% { opacity:0 } }`}</style>
    </div>
  );
}

/* ── useTypedString ───────────────────────────────────────────────── */

/**
 * Animates `full` typing out char-by-char while `active` is true.
 * Returns the empty string when inactive. The reset happens in the
 * same render via the `lastKey` guard (no setState-in-effect cascade).
 */
function useTypedString(full: string, active: boolean): string {
  // Key-based reset: changing `active`/`full` flips the key, which
  // forces a fresh typing run without needing to call setState in an
  // effect body just to clear state. Timers only fire while the effect
  // for the *current* key is alive; cleanup cancels any in-flight ones.
  const key = `${active ? '1' : '0'}:${full}`;
  const [typedByKey, setTypedByKey] = useState<{ key: string; value: string }>(
    () => ({ key, value: '' }),
  );

  useEffect(() => {
    if (!active) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const chars = Array.from(full);
    chars.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setTypedByKey({ key, value: chars.slice(0, i + 1).join('') });
        }, 60 * (i + 1)),
      );
    });
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [active, full, key]);

  // If the key drifted (active/full changed), the effect above is about to
  // re-run — return the empty-state synchronously so the UI doesn't show
  // the previous run's trailing text for one frame.
  if (typedByKey.key !== key) return '';
  return typedByKey.value;
}

/* ── Re-export the canonical steps so callers can preview copy ─────── */
export { SCAN_STEPS };
