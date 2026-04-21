// Stage 7 — Plan review. Three tabs as segmented control.
//   A — About: inline edit on pencil click, autosaves via onChange.
//   B — Timeline: thesisArc + milestones + weekly quota footer.
//   C — First week: task cards per plan_item.
//
// Confirm → POST /api/onboarding/commit → navigate to /today?from=onboarding.

'use client';

import { useMemo, useState } from 'react';
import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { OnbButton } from './_shared/onb-button';
import { OnbMono } from './_shared/onb-mono';
import { ArrowRight, Pencil, XClose } from './icons';
import { COPY } from './_copy';
import type { StrategicPath } from '@/tools/schemas';
import type { DraftState, ProductState } from './OnboardingFlow';

interface StagePlanProps {
  draft: DraftState;
  path: StrategicPath;
  connectedChannels: Array<'x' | 'reddit' | 'email'>;
  onBack: () => void;
  onAboutEdit: (patch: {
    name?: string;
    description?: string;
    audience?: string;
    voice?: string;
    keywords?: string[];
  }) => void;
  onCommit: () => Promise<void>;
}

type TabId = 'about' | 'timeline';

export function StagePlan({
  draft,
  path,
  connectedChannels,
  onBack,
  onAboutEdit,
  onCommit,
}: StagePlanProps) {
  const [tab, setTab] = useState<TabId>('about');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const handleCommit = async () => {
    setCommitting(true);
    setCommitError(null);
    try {
      await onCommit();
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
      setCommitting(false);
    }
  };

  // Tactical plan is drafted asynchronously by the team-run after commit.
  // Stage 7 summary falls back to the strategic narrative first line.
  const summary =
    path.narrative.split(/(?<=\.)\s+/)[0] ?? path.narrative;

  return (
    <div>
      <StepHeader
        kicker={COPY.stage7.kicker}
        title={COPY.stage7.title}
        sub={
          <>
            {summary}
            <span style={{ color: 'var(--sf-fg-4)' }}>
              {COPY.stage7.subSuffix}
            </span>
          </>
        }
      />

      <Tabs value={tab} onChange={setTab} />

      {tab === 'about' && (
        <AboutPanel
          draft={draft}
          connectedChannels={connectedChannels}
          onEdit={onAboutEdit}
        />
      )}
      {tab === 'timeline' && (
        <TimelinePanel path={path} state={draft.productState ?? 'launching'} />
      )}

      {commitError && (
        <div
          style={{
            marginTop: 16,
            fontSize: 13,
            color: 'var(--sf-error-ink)',
            letterSpacing: '-0.16px',
          }}
        >
          {commitError}
        </div>
      )}

      <ActionBar
        back={
          <OnbButton size="lg" variant="ghost" onClick={onBack}>
            Back
          </OnbButton>
        }
        primary={
          <OnbButton
            size="lg"
            variant="primary"
            onClick={handleCommit}
            disabled={committing}
          >
            {COPY.stage7.launchCta}
            <ArrowRight size={14} />
          </OnbButton>
        }
      />
    </div>
  );
}

function Tabs({
  value,
  onChange,
}: {
  value: TabId;
  onChange: (v: TabId) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        background: 'rgba(0,0,0,0.05)',
        borderRadius: 10,
        marginBottom: 18,
      }}
    >
      {COPY.stage7.tabs.map((t) => {
        const on = value === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id as TabId)}
            style={{
              flex: 1,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              height: 34,
              borderRadius: 7,
              background: on ? 'var(--sf-bg-secondary)' : 'transparent',
              color: on ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
              fontSize: 12.5,
              letterSpacing: '-0.12px',
              fontWeight: on ? 500 : 400,
              boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition:
                'background 150ms cubic-bezier(0.16,1,0.3,1), color 150ms',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function AboutPanel({
  draft,
  connectedChannels,
  onEdit,
}: {
  draft: DraftState;
  connectedChannels: Array<'x' | 'reddit' | 'email'>;
  onEdit: StagePlanProps['onAboutEdit'];
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const channelsLabel =
    connectedChannels.length === 0
      ? '—'
      : connectedChannels
          .map((c) =>
            c === 'reddit' ? 'Reddit' : c === 'x' ? 'X' : 'Email',
          )
          .join(', ');

  return (
    <div
      style={{
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        padding: '18px 20px',
        boxShadow: 'var(--sf-shadow-card)',
      }}
    >
      <EditRow
        label={COPY.stage7.aboutLabels.name}
        value={draft.product?.name ?? ''}
        editing={editing === 'name'}
        onEdit={() => setEditing('name')}
        onDone={() => setEditing(null)}
        onChange={(v) => onEdit({ name: v })}
      />
      <EditRow
        label={COPY.stage7.aboutLabels.description}
        value={draft.product?.description ?? ''}
        multiline
        editing={editing === 'desc'}
        onEdit={() => setEditing('desc')}
        onDone={() => setEditing(null)}
        onChange={(v) => onEdit({ description: v })}
      />
      <EditRow
        label={COPY.stage7.aboutLabels.audience}
        value={draft.audience ?? ''}
        editing={editing === 'audience'}
        onEdit={() => setEditing('audience')}
        onDone={() => setEditing(null)}
        onChange={(v) => onEdit({ audience: v })}
      />
      <EditRow
        label={COPY.stage7.aboutLabels.voice}
        value={draft.voice ?? ''}
        editing={editing === 'voice'}
        onEdit={() => setEditing('voice')}
        onDone={() => setEditing(null)}
        onChange={(v) => onEdit({ voice: v })}
      />
      <KeywordsRow
        keywords={draft.product?.keywords ?? []}
        onChange={(next) => onEdit({ keywords: next })}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          padding: '14px 0 4px',
        }}
      >
        <span
          style={{
            width: 100,
            paddingTop: 2,
            fontSize: 11,
            fontFamily: 'var(--sf-font-mono)',
            letterSpacing: '-0.08px',
            textTransform: 'uppercase',
            color: 'var(--sf-fg-4)',
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {COPY.stage7.aboutLabels.channels}
        </span>
        <div
          style={{
            flex: 1,
            fontSize: 14,
            lineHeight: 1.5,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-1)',
          }}
        >
          {channelsLabel}
        </div>
      </div>
    </div>
  );
}

function EditRow({
  label,
  value,
  multiline,
  editing,
  onEdit,
  onDone,
  onChange,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onChange: (next: string) => void;
}) {
  return (
    <div
      style={{
        padding: '14px 0',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
      }}
    >
      <span
        style={{
          width: 100,
          paddingTop: 2,
          fontSize: 11,
          fontFamily: 'var(--sf-font-mono)',
          letterSpacing: '-0.08px',
          textTransform: 'uppercase',
          color: 'var(--sf-fg-4)',
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          multiline ? (
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onDone}
              rows={4}
              autoFocus
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--sf-accent)',
                outline: 'none',
                boxShadow: 'var(--sf-shadow-focus)',
                fontFamily: 'inherit',
                fontSize: 14,
                lineHeight: 1.5,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-1)',
                resize: 'vertical',
              }}
            />
          ) : (
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onDone}
              autoFocus
              style={{
                width: '100%',
                height: 34,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--sf-accent)',
                outline: 'none',
                boxShadow: 'var(--sf-shadow-focus)',
                fontFamily: 'inherit',
                fontSize: 14,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-1)',
              }}
            />
          )
        ) : (
          <div
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}
          >
            <div
              style={{
                flex: 1,
                fontSize: 14,
                lineHeight: 1.5,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-1)',
              }}
            >
              {value || <span style={{ color: 'var(--sf-fg-4)' }}>—</span>}
            </div>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${label}`}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                margin: -4,
                color: 'rgba(0,0,0,0.40)',
                display: 'inline-flex',
              }}
            >
              <Pencil size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function KeywordsRow({
  keywords,
  onChange,
}: {
  keywords: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);

  const commit = () => {
    const v = input.trim();
    if (!v) {
      setAdding(false);
      return;
    }
    if (!keywords.includes(v)) onChange([...keywords, v]);
    setInput('');
    setAdding(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 0',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 100,
            fontSize: 11,
            fontFamily: 'var(--sf-font-mono)',
            letterSpacing: '-0.08px',
            textTransform: 'uppercase',
            color: 'var(--sf-fg-4)',
            fontWeight: 500,
          }}
        >
          {COPY.stage7.aboutLabels.keywords}
        </span>
        <OnbMono color="rgba(0,0,0,0.32)">{COPY.stage7.keywordsMeta}</OnbMono>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginTop: 4,
        }}
      >
        {keywords.map((k) => (
          <span
            key={k}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 980,
              background: 'rgba(0,113,227,0.08)',
              color: 'var(--sf-link)',
              fontSize: 12,
              letterSpacing: '-0.12px',
            }}
          >
            {k}
            <button
              type="button"
              onClick={() => onChange(keywords.filter((x) => x !== k))}
              aria-label={`Remove ${k}`}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: 'rgba(0,102,204,0.64)',
                display: 'inline-flex',
              }}
            >
              <XClose size={10} />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') {
                setInput('');
                setAdding(false);
              }
            }}
            autoFocus
            placeholder="new keyword"
            style={{
              padding: '5px 10px',
              borderRadius: 980,
              border: '1px solid var(--sf-accent)',
              outline: 'none',
              fontFamily: 'inherit',
              fontSize: 12,
              letterSpacing: '-0.12px',
              minWidth: 120,
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              padding: '5px 10px',
              borderRadius: 980,
              background: 'transparent',
              border: '1px dashed rgba(0,0,0,0.16)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              color: 'var(--sf-fg-3)',
              letterSpacing: '-0.12px',
            }}
          >
            {COPY.stage7.addKeyword}
          </button>
        )}
      </div>
    </div>
  );
}

function TimelinePanel({
  path,
  state,
}: {
  path: StrategicPath;
  state: ProductState;
}) {
  const rows = useMemo(() => {
    // Combine thesisArc (weeks) with milestones for the timeline display.
    // Cap at 4 rows so the tab stays scannable.
    const arcRows = path.thesisArc.slice(0, 4).map((w, i) => {
      const milestone = path.milestones[i];
      return {
        period: formatWeekStart(w.weekStart),
        title: w.theme,
        bullets: [
          ...(milestone ? [milestone.title] : []),
          ...(milestone ? [milestone.successMetric] : []),
          ...(w.angleMix.length > 0
            ? [`Angles: ${w.angleMix.slice(0, 3).join(' · ')}`]
            : []),
        ].slice(0, 3),
      };
    });
    return arcRows;
  }, [path]);

  const quotaLabel = computeQuotaLabel(path, state);

  return (
    <div
      style={{
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        padding: '8px 0',
        boxShadow: 'var(--sf-shadow-card)',
      }}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 18,
            padding: '16px 20px',
            borderBottom:
              i < rows.length - 1 ? '1px solid rgba(0,0,0,0.06)' : 'none',
          }}
        >
          <div style={{ width: 90, flexShrink: 0 }}>
            <OnbMono color="var(--sf-accent)">{row.period}</OnbMono>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-1)',
              }}
            >
              {row.title}
            </div>
          </div>
          <ul
            style={{
              flex: 1,
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {row.bullets.map((b, j) => (
              <li
                key={j}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  fontSize: 13,
                  lineHeight: 1.47,
                  letterSpacing: '-0.16px',
                  color: 'var(--sf-fg-2)',
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    background: 'rgba(0,0,0,0.32)',
                    marginTop: 8,
                    flexShrink: 0,
                  }}
                />
                {b}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div
        style={{
          padding: '12px 20px',
          background: 'rgba(0,0,0,0.03)',
          borderRadius: '0 0 12px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <OnbMono>{COPY.stage7.quota}</OnbMono>
        <span
          style={{
            fontSize: 12,
            letterSpacing: '-0.12px',
            color: 'var(--sf-fg-2)',
          }}
        >
          {quotaLabel}
        </span>
      </div>
    </div>
  );
}

function formatWeekStart(iso: string): string {
  try {
    const d = new Date(iso);
    return `Wk ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  } catch {
    return iso.slice(0, 10);
  }
}

function computeQuotaLabel(
  path: StrategicPath,
  state: ProductState,
): string {
  const reddit = path.channelMix.reddit?.perWeek ?? 0;
  const x = path.channelMix.x?.perWeek ?? 0;
  const total = reddit + x;
  if (total === 0) return '—';
  const period = state === 'launching' ? 'launch week' : 'per week';
  return `~${total * 5} replies · ${total} posts · ${period}`;
}

/**
 * Placeholder shown while the tactical plan is drafting in the background
 * (the team-run writes plan_items asynchronously). Intentionally non-
 * interactive — the card lives on /today once the user launches the
 * agents, so nothing to edit here yet.
 */
function FirstWeekPendingPanel() {
  return (
    <div
      style={{
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        padding: '28px 24px',
        boxShadow: 'var(--sf-shadow-card)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <OnbMono color="var(--sf-accent)">Drafting this week</OnbMono>
      <h3
        style={{
          margin: 0,
          fontSize: 18,
          fontWeight: 600,
          lineHeight: 1.25,
          letterSpacing: '-0.2px',
          color: 'var(--sf-fg-1)',
        }}
      >
        Your AI team will draft 7 days of items once you launch.
      </h3>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          lineHeight: 1.5,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-2)',
        }}
      >
        You&apos;ll see progress on{' '}
        <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 13 }}>
          /today
        </span>{' '}
        as each item comes in — expect the first drafts in about a minute.
        Nothing posts until you approve.
      </p>
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              height: 42,
              borderRadius: 10,
              background:
                'linear-gradient(90deg, rgba(0,0,0,0.035) 0%, rgba(0,0,0,0.06) 50%, rgba(0,0,0,0.035) 100%)',
              backgroundSize: '200% 100%',
              animation: `sfPlanPendingShimmer 1600ms ease-in-out ${i * 160}ms infinite`,
            }}
          />
        ))}
      </div>
      <style jsx>{`
        @keyframes sfPlanPendingShimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
      `}</style>
    </div>
  );
}
