'use client';

/**
 * My Product — CF port.
 *
 * Click-to-edit product identity (name, description, keywords, value prop,
 * website). Optimistic UI via SWR mutate(): snapshot current data → apply
 * change locally → fire PATCH /api/product → revalidate on success,
 * roll back and toast on failure.
 *
 * CF adaptation notes:
 * - State enum is mvp | launching | launched (Task A1 migration from draft/pre-launch/launched/growing)
 * - State changes go through PATCH /api/product (no separate /phase route)
 * - launchDate / launchedAt come from page.tsx as ISO strings (serialized from Date|null)
 * - derivePhase logic is inlined here; TODO: replace with import from @/lib/launch-phase (Task A2)
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

// CF schema state enum (mvp/launching/launched — migrated from draft/pre-launch/launched/growing)
type State = 'mvp' | 'launching' | 'launched';

type LaunchPhase =
  | 'foundation'
  | 'audience'
  | 'momentum'
  | 'launch'
  | 'compound'
  | 'steady';

const STATE_LABEL: Record<State, string> = {
  mvp: 'Building',
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

// Adapted derivePhase for new state enum (mvp/launching/launched)
// TODO(Task A2): replace with import { derivePhase } from "@/lib/launch-phase"
function derivePhase({
  state,
  launchDate,
  launchedAt,
}: {
  state: State;
  launchDate: string | null;
  launchedAt: string | null;
}): LaunchPhase {
  const now = Date.now();

  if (state === 'launched') {
    if (!launchedAt) return 'steady';
    const daysSince = (now - new Date(launchedAt).getTime()) / 86_400_000;
    // Fresh launch (within 30d) → compound momentum; older → steady.
    return daysSince <= 30 ? 'compound' : 'steady';
  }

  if (state === 'mvp') {
    if (!launchDate) return 'foundation';
    const daysToLaunch = (new Date(launchDate).getTime() - now) / 86_400_000;
    if (daysToLaunch <= 0) return 'launch';
    if (daysToLaunch <= 7) return 'momentum';
    if (daysToLaunch <= 28) return 'audience';
    return 'foundation';
  }

  // state === 'launching'
  if (!launchDate) return 'audience';
  const daysToLaunch = (new Date(launchDate).getTime() - now) / 86_400_000;
  if (daysToLaunch <= 0) return 'launch';
  if (daysToLaunch <= 7) return 'momentum';
  return 'audience';
}

/**
 * Wire shape for product data. All date fields are ISO 8601 strings on the
 * wire (serialized from D1 timestamp_ms by either `page.tsx` for the
 * initial snapshot or `/api/product` GET for revalidation). Use
 * `new Date(snap.launchDate)` directly — do not divide by 1000.
 */
export interface ProductSnapshot {
  name: string | null;
  description: string | null;
  keywords: string[] | null;
  valueProp: string | null;
  url: string | null;
  state: State;
  /** ISO date string — set when state='launching'. */
  launchDate: string | null;
  /** ISO date string — set when state='launched'. */
  launchedAt: string | null;
  /** ISO date string for display. */
  updatedAt: string | null;
  /** ISO date string for display. */
  createdAt: string | null;
}

/** Subset of ProductSnapshot the founder edits inline via PATCH /api/product. */
type FieldPatch = Partial<
  Pick<ProductSnapshot, 'name' | 'description' | 'valueProp' | 'url' | 'keywords'>
>;

interface ProductContentProps {
  initial: ProductSnapshot;
}

const fetcher = async (url: string): Promise<ProductSnapshot> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`product fetch failed: ${res.status}`);
  // The `/api/product` route returns the raw drizzle row; Date columns get
  // serialized to ISO strings by JSON.stringify on the server, so the wire
  // shape matches ProductSnapshot directly. Keep null-safe defaults for the
  // first-time-user case where no row exists yet.
  const data = (await res.json()) as Partial<ProductSnapshot>;
  return {
    name: data.name ?? null,
    description: data.description ?? null,
    keywords: data.keywords ?? [],
    valueProp: data.valueProp ?? null,
    url: data.url ?? null,
    state: data.state ?? 'mvp',
    launchDate: data.launchDate ?? null,
    launchedAt: data.launchedAt ?? null,
    updatedAt: data.updatedAt ?? null,
    createdAt: data.createdAt ?? null,
  };
};

export function ProductContent({ initial }: ProductContentProps) {
  const router = useRouter();
  const { toast } = useToast();

  const { data, mutate } = useSWR<ProductSnapshot>('/api/product', fetcher, {
    fallbackData: initial,
    revalidateOnMount: false,
  });
  const product = data ?? initial;

  const currentPhase = derivePhase({
    state: product.state,
    launchDate: product.launchDate,
    launchedAt: product.launchedAt,
  });

  const commitField = async (patch: FieldPatch) => {
    const previous = product;
    const next: ProductSnapshot = { ...product, ...patch };
    // Optimistic
    await mutate(next, { revalidate: false });
    try {
      const body: FieldPatch = {
        url: next.url,
        name: next.name,
        description: next.description,
        keywords: next.keywords ?? [],
        valueProp: next.valueProp ?? null,
      };
      const res = await fetch('/api/product', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  const lastUpdated = product.updatedAt
    ? new Date(product.updatedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'never';

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
                    {product.name ?? 'Untitled Product'}
                  </h2>
                  <Badge variant={phaseVariant(currentPhase)} mono>
                    {PHASE_LABEL[currentPhase]}
                  </Badge>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '14px', color: 'var(--sf-fg-3)' }}>
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
                  value={product.name ?? ''}
                  onCommit={(next) => commitField({ name: next.trim() || 'Untitled Product' })}
                />
              </FieldRow>
              <FieldRow label="Description">
                <EditableValue
                  value={product.description ?? ''}
                  multiline
                  onCommit={(next) => commitField({ description: next.trim() || null })}
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
                  value={product.keywords ?? []}
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
                    fontSize: '14px',
                    color: 'var(--sf-fg-2)',
                    display: 'inline-flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span className="sf-mono" style={{ letterSpacing: 'var(--sf-track-mono)' }}>
                    {PHASE_LABEL[currentPhase]}
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
                  fontSize: '12px',
                  color: 'var(--sf-fg-2)',
                  letterSpacing: 'var(--sf-track-mono)',
                }}
              >
                {(product.keywords ?? []).length} keywords · last saved {lastUpdated}
              </span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function phaseVariant(phase: LaunchPhase): 'warning' | 'success' | 'accent' {
  if (phase === 'launch') return 'success';
  if (phase === 'compound' || phase === 'steady') return 'accent';
  return 'warning';
}

// ----------------------------------------------------------------
// State editor — picker for mvp / launching / launched
// + the matching launch date. Saves via PATCH /api/product.
// ----------------------------------------------------------------

const STATE_OPTIONS: { id: State; label: string; sub: string }[] = [
  { id: 'mvp', label: 'Building', sub: 'MVP phase, no launch date yet' },
  { id: 'launching', label: 'Launching', sub: 'Has a launch date set' },
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  // `launchedAt` is server-managed (set when a row's state transitions to
  // `launched` for the first time). The PATCH route rejects client writes
  // to it, so we surface it as read-only here rather than offering a date
  // picker that silently no-ops.
  const launchedAtDisplay = isoToYmd(launchedAt);

  const reset = () => {
    setDraftState(state);
    setDraftLaunchDate(isoToYmd(launchDate) || ymdPlusDays(7));
    setError(null);
    setEditing(false);
  };

  const summary = (() => {
    if (state === 'mvp') return STATE_LABEL.mvp;
    if (state === 'launching') {
      const date = isoToYmd(launchDate);
      return date ? `${STATE_LABEL.launching} · ${date}` : STATE_LABEL.launching;
    }
    // launched
    return launchedAtDisplay
      ? `${STATE_LABEL.launched} · ${launchedAtDisplay}`
      : STATE_LABEL.launched;
  })();

  const hasChanges = (() => {
    if (draftState !== state) return true;
    if (draftState === 'launching' && draftLaunchDate !== isoToYmd(launchDate)) return true;
    return false;
  })();

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      // Build PATCH body. API contract: `launchDate` is Unix SECONDS (a
      // number) or null to clear. `launchedAt` is NOT writable from this
      // client — the route ignores any client-supplied value.
      const body: { state: State; launchDate: number | null } = {
        state: draftState,
        launchDate:
          draftState === 'launching'
            ? Math.floor(new Date(`${draftLaunchDate}T00:00:00.000Z`).getTime() / 1000)
            : null,
      };

      const res = await fetch('/api/product', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? 'state_change_failed');
      }
      toast('State updated.');
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
          fontSize: '14px',
          transition: 'border-color var(--sf-dur-fast) var(--sf-ease)',
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
                fontSize: '14px',
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
            fontSize: '12px',
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
              fontSize: '14px',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-sm)',
              background: 'var(--sf-bg-primary)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'inherit',
            }}
          />
        </label>
      )}
      {draftState === 'launched' && launchedAtDisplay && (
        <span
          style={{
            fontSize: '12px',
            color: 'var(--sf-fg-3)',
          }}
        >
          Launched on{' '}
          <span className="sf-mono" style={{ letterSpacing: 'var(--sf-track-mono)' }}>
            {launchedAtDisplay}
          </span>
        </span>
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
            fontSize: '12px',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          <strong style={{ fontWeight: 600 }}>Heads up:</strong> saving updates your
          product state. Already-approved or posted items aren&apos;t touched.
        </div>
      )}
      {error && (
        <span style={{ fontSize: '12px', color: 'var(--sf-error-ink)' }}>
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
            fontSize: '14px',
            cursor: saving ? 'wait' : hasChanges ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            opacity: !hasChanges ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : hasChanges ? 'Save state' : 'No changes'}
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
            fontSize: '14px',
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
            fontSize: '12px',
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
            fontSize: '12px',
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
