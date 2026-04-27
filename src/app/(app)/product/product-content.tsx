'use client';

/**
 * My Product — v2.
 *
 * Click-to-edit product identity (name, description, keywords, value prop,
 * website). Optimistic UI via SWR mutate(): snapshot current data → apply
 * change locally → fire PATCH /api/product → revalidate on success,
 * roll back and toast on failure.
 *
 * Pixel reference: handoff pages.jsx `MyProductView`.
 */

import { useState } from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Ops } from '@/components/ui/ops';
import { FieldRow } from '@/components/ui/field-row';
import { useToast } from '@/components/ui/toast';
import { EditableValue } from './_components/editable-value';

type State = 'mvp' | 'launching' | 'launched';
type LaunchPhase =
  | 'foundation'
  | 'audience'
  | 'momentum'
  | 'launch'
  | 'compound'
  | 'steady';

const STATE_LABEL: Record<State, string> = {
  mvp: 'MVP',
  launching: 'Launching',
  launched: 'Launched',
};

const PHASE_LABEL: Record<LaunchPhase, string> = {
  foundation: 'Foundation',
  audience: 'Audience',
  momentum: 'Momentum',
  launch: 'Launch',
  compound: 'Compound',
  steady: 'Steady',
};

export interface ProductSnapshot {
  name: string;
  description: string;
  keywords: string[];
  valueProp: string | null;
  url: string | null;
  state: State;
  /** ISO date — required when state='launching'. */
  launchDate: string | null;
  /** ISO date — required when state='launched'. */
  launchedAt: string | null;
  currentPhase: LaunchPhase;
  updatedAt: string;
}

interface ProductContentProps {
  initial: ProductSnapshot;
}

const fetcher = async (url: string): Promise<ProductSnapshot> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load product');
  return res.json();
};

export function ProductContent({ initial }: ProductContentProps) {
  const router = useRouter();
  const { toast } = useToast();

  // Use SWR with initialData so the page hydrates without a flash, but benefits
  // from revalidation + mutate() on edit.
  const { data, mutate } = useSWR<ProductSnapshot>('/api/product', fetcher, {
    fallbackData: initial,
    revalidateOnMount: false,
  });
  const product = data ?? initial;

  const commitField = async (patch: Partial<ProductSnapshot>) => {
    const previous = product;
    const next = { ...product, ...patch } as ProductSnapshot;
    // Optimistic
    await mutate(next, { revalidate: false });
    try {
      const res = await fetch('/api/product', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: next.url,
          name: next.name,
          description: next.description,
          keywords: next.keywords,
          valueProp: next.valueProp ?? null,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Save failed');
      }
      toast('Saved');
      router.refresh();
    } catch (err) {
      // Roll back
      await mutate(previous, { revalidate: false });
      toast(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const lastUpdated = new Date(product.updatedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const initial_ = (product.name?.[0] ?? 'P').toUpperCase();

  return (
    <>
      <HeaderBar
        title="My Product"
        meta={`Click any field to edit · Last updated ${lastUpdated}`}
      />
      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card padding={24}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div
                aria-hidden="true"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  background:
                    'linear-gradient(135deg, oklch(60% 0.18 250), oklch(68% 0.14 200))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 26,
                  boxShadow: 'var(--sf-shadow-card)',
                  flexShrink: 0,
                }}
              >
                {initial_}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <h2 className="sf-h3" style={{ margin: 0, color: 'var(--sf-fg-1)' }}>
                    {product.name}
                  </h2>
                  <Badge variant={phaseVariant(product.currentPhase)} mono>
                    {PHASE_LABEL[product.currentPhase]}
                  </Badge>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-3)' }}>
                  <EditableValue
                    value={product.url ?? ''}
                    onCommit={(next) => commitField({ url: next.trim() || null })}
                    placeholder="Add a website"
                  />
                </p>
              </div>
            </div>

            <div style={{ marginTop: 20 }}>
              <FieldRow label="Name">
                <EditableValue
                  value={product.name}
                  onCommit={(next) => commitField({ name: next.trim() || 'Untitled Product' })}
                />
              </FieldRow>
              <FieldRow label="Description">
                <EditableValue
                  value={product.description}
                  multiline
                  onCommit={(next) => commitField({ description: next.trim() || '-' })}
                />
              </FieldRow>
              <FieldRow label="Value prop">
                <EditableValue
                  value={product.valueProp ?? ''}
                  multiline
                  placeholder="One sentence — what your product does."
                  onCommit={(next) => commitField({ valueProp: next.trim() || null })}
                />
              </FieldRow>
              <FieldRow label="Keywords">
                <KeywordsEditor
                  value={product.keywords}
                  onCommit={(next) => commitField({ keywords: next })}
                />
              </FieldRow>
              <FieldRow label="State">
                <StateEditor
                  state={product.state}
                  launchDate={product.launchDate}
                  launchedAt={product.launchedAt}
                  onSaved={async () => {
                    await mutate();
                    router.refresh();
                  }}
                />
              </FieldRow>
              <FieldRow label="Phase" muted>
                <span
                  style={{
                    fontSize: 'var(--sf-text-sm)',
                    color: 'var(--sf-fg-2)',
                    display: 'inline-flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span className="sf-mono" style={{ letterSpacing: 'var(--sf-track-mono)' }}>
                    {PHASE_LABEL[product.currentPhase]}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--sf-fg-4)' }}>
                    derived from state + launch date
                  </span>
                </span>
              </FieldRow>
            </div>

            <div
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTop: '1px solid var(--sf-border-subtle)',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Ops>Profile fingerprint</Ops>
              <span
                className="sf-mono"
                style={{
                  fontSize: 'var(--sf-text-xs)',
                  color: 'var(--sf-fg-2)',
                  letterSpacing: 'var(--sf-track-mono)',
                }}
              >
                {product.keywords.length} keywords · last saved {lastUpdated}
              </span>
            </div>
          </Card>
        </div>
      </div>

    </>
  );
}

function phaseVariant(
  phase: LaunchPhase,
): 'warning' | 'success' | 'accent' {
  if (phase === 'launch') return 'success';
  if (phase === 'compound' || phase === 'steady') return 'accent';
  return 'warning';
}

// ----------------------------------------------------------------
// State editor — picker for mvp / launching / launched + the
// matching launch date. Saves via POST /api/product/phase, which
// kicks off an async strategic replan; the row updates immediately
// and the team-run runs in the background.
// ----------------------------------------------------------------

const STATE_OPTIONS: { id: State; label: string; sub: string }[] = [
  { id: 'mvp', label: 'MVP', sub: 'Building, no launch date yet' },
  { id: 'launching', label: 'Launching', sub: 'Has a launch date' },
  { id: 'launched', label: 'Launched', sub: 'Already in market' },
];

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoToYmd(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function ymdToIso(ymd: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toISOString();
}

function StateEditor({
  state,
  launchDate,
  launchedAt,
  onSaved,
}: {
  state: State;
  launchDate: string | null;
  launchedAt: string | null;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftState, setDraftState] = useState<State>(state);
  const [draftLaunchDate, setDraftLaunchDate] = useState<string>(
    isoToYmd(launchDate) || ymdPlusDays(7),
  );
  const [draftLaunchedAt, setDraftLaunchedAt] = useState<string>(
    isoToYmd(launchedAt) || todayYmd(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const reset = () => {
    setDraftState(state);
    setDraftLaunchDate(isoToYmd(launchDate) || ymdPlusDays(7));
    setDraftLaunchedAt(isoToYmd(launchedAt) || todayYmd());
    setError(null);
    setEditing(false);
  };

  const summary = (() => {
    if (state === 'mvp') return STATE_LABEL.mvp;
    if (state === 'launching') {
      const date = isoToYmd(launchDate);
      return date ? `${STATE_LABEL.launching} · ${date}` : STATE_LABEL.launching;
    }
    const date = isoToYmd(launchedAt);
    return date ? `${STATE_LABEL.launched} · ${date}` : STATE_LABEL.launched;
  })();

  const hasChanges = (() => {
    if (draftState !== state) return true;
    if (draftState === 'launching' && draftLaunchDate !== isoToYmd(launchDate)) return true;
    if (draftState === 'launched' && draftLaunchedAt !== isoToYmd(launchedAt)) return true;
    return false;
  })();

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = { state: draftState };
      if (draftState === 'launching') {
        body.launchDate = ymdToIso(draftLaunchDate);
        body.launchedAt = null;
      } else if (draftState === 'launched') {
        body.launchedAt = ymdToIso(draftLaunchedAt);
        body.launchDate = null;
      } else {
        body.launchDate = null;
        body.launchedAt = null;
      }

      const res = await fetch('/api/product/phase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; detail?: unknown }
          | null;
        throw new Error(payload?.error ?? 'phase_change_failed');
      }
      toast('State updated — replanning your launch in the background.');
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 8,
          padding: 0,
          margin: 0,
          background: 'transparent',
          border: 'none',
          borderBottom: '1px dashed transparent',
          cursor: 'text',
          fontFamily: 'inherit',
          color: 'var(--sf-fg-1)',
          fontSize: 'var(--sf-text-sm)',
          transition: 'border-color var(--sf-dur-fast) var(--sf-ease-swift)',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'var(--sf-border)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'transparent';
        }}
      >
        <span className="sf-mono" style={{ letterSpacing: 'var(--sf-track-mono)' }}>
          {summary}
        </span>
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATE_OPTIONS.map((opt) => {
          const selected = draftState === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={saving}
              onClick={() => setDraftState(opt.id)}
              title={opt.sub}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--sf-radius-pill)',
                border: selected
                  ? '1px solid var(--sf-accent)'
                  : '1px solid var(--sf-border)',
                background: selected ? 'var(--sf-accent-light)' : 'var(--sf-bg-primary)',
                color: selected ? 'var(--sf-accent-ink)' : 'var(--sf-fg-1)',
                fontSize: 'var(--sf-text-sm)',
                fontWeight: selected ? 600 : 500,
                cursor: saving ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {draftState === 'launching' && (
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
          }}
        >
          Launch date
          <input
            type="date"
            value={draftLaunchDate}
            disabled={saving}
            min={todayYmd()}
            max={ymdPlusDays(90)}
            onChange={(e) => setDraftLaunchDate(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: 'var(--sf-text-sm)',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-sm)',
              background: 'var(--sf-bg-primary)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'inherit',
            }}
          />
        </label>
      )}
      {draftState === 'launched' && (
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
          }}
        >
          Launched on
          <input
            type="date"
            value={draftLaunchedAt}
            disabled={saving}
            max={todayYmd()}
            onChange={(e) => setDraftLaunchedAt(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: 'var(--sf-text-sm)',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-sm)',
              background: 'var(--sf-bg-primary)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'inherit',
            }}
          />
        </label>
      )}
      {hasChanges && (
        <div
          role="status"
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--sf-radius-sm)',
            border: '1px solid var(--sf-warning-border, rgba(180, 120, 0, 0.3))',
            background: 'var(--sf-warning-light, rgba(255, 196, 0, 0.08))',
            color: 'var(--sf-warning-ink, var(--sf-fg-2))',
            fontSize: 'var(--sf-text-xs)',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          <strong style={{ fontWeight: 600 }}>Heads up:</strong> saving replans
          your launch. This week&apos;s pre-approval plan items get superseded and
          a fresh strategic + tactical run kicks off in the background
          (≈30–60s). Already-approved or posted items aren&apos;t touched.
        </div>
      )}
      {error && (
        <span style={{ fontSize: 'var(--sf-text-xs)', color: 'var(--sf-error-ink)' }}>
          {error}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={saving || !hasChanges}
          onClick={() => void save()}
          style={{
            padding: '4px 12px',
            borderRadius: 'var(--sf-radius-sm)',
            border: '1px solid var(--sf-accent)',
            background: hasChanges ? 'var(--sf-accent)' : 'var(--sf-bg-tertiary)',
            color: hasChanges ? 'var(--sf-on-accent)' : 'var(--sf-fg-3)',
            fontSize: 'var(--sf-text-sm)',
            cursor: saving ? 'wait' : hasChanges ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            opacity: !hasChanges ? 0.6 : 1,
          }}
        >
          {saving ? 'Replanning…' : hasChanges ? 'Replan launch' : 'No changes'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={reset}
          style={{
            padding: '4px 12px',
            borderRadius: 'var(--sf-radius-sm)',
            border: '1px solid var(--sf-border)',
            background: 'transparent',
            color: 'var(--sf-fg-2)',
            fontSize: 'var(--sf-text-sm)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function KeywordsEditor({
  value,
  onCommit,
}: {
  value: string[];
  onCommit: (next: string[]) => Promise<void> | void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {value.map((kw) => (
        <Badge key={kw}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {kw}
            <button
              type="button"
              onClick={() => void onCommit(value.filter((k) => k !== kw))}
              aria-label={`Remove ${kw}`}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                padding: 0,
                cursor: 'pointer',
                opacity: 0.6,
              }}
            >
              ×
            </button>
          </span>
        </Badge>
      ))}
      {adding ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const trimmed = draft.trim();
              if (trimmed && !value.includes(trimmed)) {
                void onCommit([...value, trimmed]);
              }
              setDraft('');
              setAdding(false);
            } else if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          onBlur={() => {
            const trimmed = draft.trim();
            if (trimmed && !value.includes(trimmed)) {
              void onCommit([...value, trimmed]);
            }
            setDraft('');
            setAdding(false);
          }}
          style={{
            padding: '2px 8px',
            height: 22,
            fontSize: 'var(--sf-text-xs)',
            border: '1px solid var(--sf-accent)',
            borderRadius: 'var(--sf-radius-sm)',
            background: 'var(--sf-bg-primary)',
            color: 'var(--sf-fg-1)',
            outline: 'none',
            fontFamily: 'inherit',
            minWidth: 80,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            padding: '2px 10px',
            height: 22,
            borderRadius: 'var(--sf-radius-pill)',
            border: '1px dashed var(--sf-border)',
            background: 'transparent',
            color: 'var(--sf-fg-3)',
            fontSize: 'var(--sf-text-xs)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + add
        </button>
      )}
    </div>
  );
}


