'use client';

/**
 * My Product — v2.
 *
 * Click-to-edit product identity (name, description, keywords, value prop,
 * website). Optimistic UI via SWR mutate(): snapshot current data → apply
 * change locally → fire PUT /api/onboarding/profile → revalidate on success,
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
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { SectionBar } from '@/components/ui/section-bar';
import { FieldRow } from '@/components/ui/field-row';
import { useToast } from '@/components/ui/toast';
import { EditableValue } from './_components/editable-value';

type Phase = 'pre_launch' | 'launched' | 'scaling';
const PHASE_LABEL: Record<Phase, string> = {
  pre_launch: 'Pre-Launch',
  launched: 'Launched',
  scaling: 'Scaling',
};

export interface ProductSnapshot {
  name: string;
  description: string;
  keywords: string[];
  valueProp: string | null;
  url: string | null;
  lifecyclePhase: Phase;
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

  const [bannedPhrases, setBannedPhrases] = useState<string[]>([
    'crushing it',
    'game-changer',
    'unlock',
    '10x',
    'revolutionize',
  ]);

  const commitField = async (patch: Partial<ProductSnapshot>) => {
    const previous = product;
    const next = { ...product, ...patch } as ProductSnapshot;
    // Optimistic
    await mutate(next, { revalidate: false });
    try {
      const res = await fetch('/api/onboarding/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: next.url,
          name: next.name,
          description: next.description,
          keywords: next.keywords,
          valueProp: next.valueProp ?? undefined,
          lifecyclePhase: next.lifecyclePhase,
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
        meta={`The voice and rules your AI team uses when writing as you · Last updated ${lastUpdated}`}
        action={
          <Button variant="ghost" size="sm" onClick={() => router.push('/onboarding')}>
            Re-run voice scan
          </Button>
        }
      />
      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        {/* Identity + Positioning — 2-col hero */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)',
            gap: 16,
          }}
          className="product-hero-grid"
        >
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
                  boxShadow: 'var(--sf-shadow-sm)',
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
                  <Badge variant={phaseVariant(product.lifecyclePhase)} mono>
                    {PHASE_LABEL[product.lifecyclePhase]}
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
              <FieldRow label="Lifecycle" muted>
                <PhaseTabs
                  value={product.lifecyclePhase}
                  onChange={(next) => commitField({ lifecyclePhase: next })}
                />
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

          {/* Voice tone sliders */}
          <VoiceDnaCard />
        </div>

        {/* Guardrails */}
        <SectionBar count={`${bannedPhrases.length} rules`}>Guardrails</SectionBar>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          <Card padding={20}>
            <Ops style={{ display: 'block', marginBottom: 10 }}>Never say</Ops>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {bannedPhrases.map((w) => (
                <span
                  key={w}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    borderRadius: 'var(--sf-radius-pill)',
                    background: 'var(--sf-danger-tint)',
                    color: 'var(--sf-danger-ink)',
                    fontSize: 'var(--sf-text-xs)',
                    fontWeight: 500,
                  }}
                >
                  <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{w}</span>
                  <button
                    type="button"
                    onClick={() => setBannedPhrases((prev) => prev.filter((p) => p !== w))}
                    aria-label={`Remove ${w}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: 0,
                      marginLeft: 2,
                      fontSize: 11,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <AddPhraseButton
                onAdd={(phrase) => setBannedPhrases((prev) => [...prev, phrase])}
              />
            </div>
          </Card>
          <Card padding={20}>
            <Ops style={{ display: 'block', marginBottom: 10 }}>FTC disclosures</Ops>
            <p
              style={{
                margin: 0,
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-2)',
                lineHeight: 'var(--sf-lh-normal)',
              }}
            >
              Every reply mentioning{' '}
              <span style={{ fontWeight: 600, color: 'var(--sf-fg-1)' }}>{product.name}</span>{' '}
              includes an
              <span
                style={{
                  display: 'inline-block',
                  margin: '0 4px',
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: 'var(--sf-paper-sunken)',
                  fontFamily: 'var(--sf-font-mono)',
                  fontSize: 'var(--sf-text-xs)',
                }}
              >
                (I work here)
              </span>
              affiliation tag.
            </p>
          </Card>
          <Card padding={20}>
            <Ops style={{ display: 'block', marginBottom: 10 }}>Hard caps</Ops>
            <div style={{ display: 'grid', gap: 8, fontSize: 'var(--sf-text-sm)' }}>
              <CapRow label="Replies per community / day" value="3" />
              <CapRow label="Hours between any 2 replies" value="1h" />
              <CapRow label="Monthly post budget" value="120" />
            </div>
          </Card>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 900px) {
          .product-hero-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
    </>
  );
}

function phaseVariant(
  phase: Phase,
): 'warning' | 'success' | 'signal' {
  if (phase === 'launched') return 'success';
  if (phase === 'scaling') return 'signal';
  return 'warning';
}

function CapRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--sf-fg-2)' }}>{label}</span>
      <span className="sf-mono" style={{ color: 'var(--sf-fg-1)' }}>
        {value}
      </span>
    </div>
  );
}

function PhaseTabs({
  value,
  onChange,
}: {
  value: Phase;
  onChange: (next: Phase) => void;
}) {
  const phases: Phase[] = ['pre_launch', 'launched', 'scaling'];
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {phases.map((p) => {
        const active = p === value;
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--sf-radius-sm)',
              border: 'none',
              background: active ? 'var(--sf-signal-tint)' : 'transparent',
              color: active ? 'var(--sf-signal-ink)' : 'var(--sf-fg-3)',
              fontSize: 'var(--sf-text-xs)',
              fontWeight: active ? 600 : 500,
              letterSpacing: 'var(--sf-track-normal)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all var(--sf-dur-fast) var(--sf-ease-swift)',
            }}
          >
            {PHASE_LABEL[p]}
          </button>
        );
      })}
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
            border: '1px solid var(--sf-signal)',
            borderRadius: 'var(--sf-radius-sm)',
            background: 'var(--sf-paper)',
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

function AddPhraseButton({ onAdd }: { onAdd: (phrase: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  if (adding) {
    return (
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (draft.trim()) onAdd(draft.trim());
            setDraft('');
            setAdding(false);
          }
          if (e.key === 'Escape') {
            setDraft('');
            setAdding(false);
          }
        }}
        onBlur={() => {
          if (draft.trim()) onAdd(draft.trim());
          setDraft('');
          setAdding(false);
        }}
        placeholder="Phrase to ban"
        style={{
          padding: '2px 10px',
          height: 22,
          borderRadius: 'var(--sf-radius-pill)',
          border: '1px solid var(--sf-signal)',
          background: 'var(--sf-paper)',
          color: 'var(--sf-fg-1)',
          fontSize: 'var(--sf-text-xs)',
          outline: 'none',
          fontFamily: 'inherit',
        }}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      style={{
        padding: '3px 10px',
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
  );
}

function VoiceDnaCard() {
  const [tone, setTone] = useState({ warmth: 55, wit: 68, formality: 28, brevity: 72 });
  const axes: { key: keyof typeof tone; left: string; right: string }[] = [
    { key: 'warmth', left: 'Blunt', right: 'Warm' },
    { key: 'wit', left: 'Serious', right: 'Witty' },
    { key: 'formality', left: 'Casual', right: 'Formal' },
    { key: 'brevity', left: 'Expansive', right: 'Brief' },
  ];
  const phrases = [
    'Moved from Jira → Linear 8 months ago',
    'cmd+k everywhere',
    'Counterintuitive:',
    'Worth a weekend trial',
  ];
  return (
    <Card padding={24}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <h3 className="sf-h4" style={{ margin: 0, color: 'var(--sf-fg-1)' }}>
          Voice DNA
        </h3>
        <Badge variant="signal" mono>
          TRAINED
        </Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {axes.map((s) => (
          <div key={s.key}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                color: 'var(--sf-fg-3)',
                marginBottom: 4,
                fontFamily: 'var(--sf-font-mono)',
                letterSpacing: 'var(--sf-track-mono)',
              }}
            >
              <span>{s.left}</span>
              <span style={{ color: 'var(--sf-fg-1)', fontWeight: 600 }}>{tone[s.key]}</span>
              <span>{s.right}</span>
            </div>
            <div
              style={{
                position: 'relative',
                height: 6,
                borderRadius: 3,
                background: 'var(--sf-paper-sunken)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${tone[s.key]}%`,
                  background:
                    'linear-gradient(90deg, var(--sf-signal), var(--sf-flare))',
                  borderRadius: 3,
                }}
              />
              <input
                type="range"
                min={0}
                max={100}
                value={tone[s.key]}
                onChange={(e) =>
                  setTone((prev) => ({ ...prev, [s.key]: Number(e.target.value) }))
                }
                aria-label={`${s.left} to ${s.right}`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'ew-resize',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: `calc(${tone[s.key]}% - 7px)`,
                  top: -4,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  background: 'var(--sf-paper)',
                  border: '2px solid var(--sf-signal)',
                  boxShadow: 'var(--sf-shadow-sm)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 20,
          padding: 14,
          background: 'var(--sf-paper-sunken)',
          borderRadius: 'var(--sf-radius-md)',
        }}
      >
        <Ops style={{ marginBottom: 8, display: 'block' }}>Signature phrases</Ops>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {phrases.map((p) => (
            <div
              key={p}
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-1)',
                fontStyle: 'italic',
                borderLeft: '2px solid var(--sf-signal)',
                paddingLeft: 10,
              }}
            >
              &ldquo;{p}&rdquo;
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
