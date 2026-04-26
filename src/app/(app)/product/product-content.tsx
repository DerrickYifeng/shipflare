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
              <FieldRow label="State" muted>
                <span
                  className="sf-mono"
                  style={{
                    fontSize: 'var(--sf-text-xs)',
                    color: 'var(--sf-fg-2)',
                    letterSpacing: 'var(--sf-track-mono)',
                  }}
                >
                  {STATE_LABEL[product.state]}
                </span>
              </FieldRow>
              <FieldRow label="Phase" muted>
                <span
                  className="sf-mono"
                  style={{
                    fontSize: 'var(--sf-text-xs)',
                    color: 'var(--sf-fg-2)',
                    letterSpacing: 'var(--sf-track-mono)',
                  }}
                >
                  {PHASE_LABEL[product.currentPhase]}
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


