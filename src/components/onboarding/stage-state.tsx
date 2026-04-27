// Stage 5 — State picker. 3 radio cards for mvp/launching/launched. Launching
// reveals a date + channel sub-form; launched reveals a users-bucket sub-form.

'use client';

import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { OnbButton } from './_shared/onb-button';
import { StateCard } from './_shared/state-card';
import { OnbMono } from './_shared/onb-mono';
import { Field } from './_shared/field';
import { ArrowRight } from './icons';
import { COPY } from './_copy';
import type { LaunchChannel, ProductState, UsersBucket } from './OnboardingFlow';

interface StageStateProps {
  productState: ProductState | null;
  launchDate: string | null;
  launchedAt: string | null;
  launchChannel: LaunchChannel | null;
  usersBucket: UsersBucket | null;
  onBack: () => void;
  onChange: (patch: {
    productState?: ProductState;
    launchDate?: string | null;
    launchedAt?: string | null;
    launchChannel?: LaunchChannel | null;
    usersBucket?: UsersBucket | null;
  }) => void;
  onGeneratePlan: () => void;
}

function defaultLaunchDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function defaultLaunchedAt(): string {
  // Default to today — the user most likely launched recently if they're
  // picking "Launched · growing" in onboarding.
  return new Date().toISOString().slice(0, 10);
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function threeYearsAgoYmd(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
}

const miniInputStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  padding: '0 12px',
  borderRadius: 8,
  border: '1px solid rgba(0,0,0,0.12)',
  background: 'var(--sf-bg-secondary)',
  fontFamily: 'inherit',
  fontSize: 14,
  letterSpacing: '-0.16px',
  color: 'var(--sf-fg-1)',
  outline: 'none',
};

export function StageState({
  productState,
  launchDate,
  launchedAt,
  launchChannel,
  usersBucket,
  onBack,
  onChange,
  onGeneratePlan,
}: StageStateProps) {
  const picked = productState ?? 'launching';

  return (
    <div>
      <StepHeader
        kicker={COPY.stage5.kicker}
        title={COPY.stage5.title}
        sub={COPY.stage5.sub}
      />

      <div
        role="radiogroup"
        aria-label={COPY.stage5.title}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {COPY.stage5.options.map((opt) => (
          <StateCard
            key={opt.id}
            option={opt}
            selected={picked === opt.id}
            onSelect={() =>
              onChange({ productState: opt.id as ProductState })
            }
            recommendedLabel={COPY.stage5.recommendedBadge}
          />
        ))}
      </div>

      {picked === 'launching' && (
        <div
          style={{
            marginTop: 16,
            padding: '16px 18px',
            background: 'var(--sf-bg-secondary)',
            borderRadius: 12,
            boxShadow: 'var(--sf-shadow-card)',
          }}
        >
          <OnbMono>{COPY.stage5.launchDetailsTitle}</OnbMono>
          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 14,
            }}
          >
            <Field label="Launch date">
              <input
                type="date"
                value={launchDate ?? defaultLaunchDate()}
                onChange={(e) => onChange({ launchDate: e.target.value })}
                style={miniInputStyle}
              />
            </Field>
            <Field label="Channel">
              <select
                value={launchChannel ?? 'producthunt'}
                onChange={(e) =>
                  onChange({ launchChannel: e.target.value as LaunchChannel })
                }
                style={miniInputStyle}
              >
                {COPY.stage5.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      )}

      {picked === 'launched' && (
        <div
          style={{
            marginTop: 16,
            padding: '16px 18px',
            background: 'var(--sf-bg-secondary)',
            borderRadius: 12,
            boxShadow: 'var(--sf-shadow-card)',
          }}
        >
          <OnbMono>When did you launch?</OnbMono>
          <div style={{ marginTop: 12 }}>
            <Field
              label="Launch date"
              hint="Any time in the last 3 years — we use this to weight compound-growth planning."
            >
              <input
                type="date"
                value={launchedAt ?? defaultLaunchedAt()}
                min={threeYearsAgoYmd()}
                max={todayYmd()}
                onChange={(e) => onChange({ launchedAt: e.target.value })}
                style={miniInputStyle}
              />
            </Field>
          </div>
          <div style={{ marginTop: 18 }}>
            <OnbMono>{COPY.stage5.usersTitle}</OnbMono>
            <div
              style={{
                marginTop: 10,
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              {COPY.stage5.userBuckets.map((b) => {
                const on = usersBucket === b;
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => onChange({ usersBucket: b })}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 980,
                      background: on
                        ? 'var(--sf-accent)'
                        : 'rgba(0,0,0,0.05)',
                      color: on ? '#fff' : 'var(--sf-fg-1)',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      letterSpacing: '-0.16px',
                      transition:
                        'background 150ms cubic-bezier(0.16,1,0.3,1), color 150ms',
                    }}
                  >
                    {b === '100-1k'
                      ? '100–1k'
                      : b === '1k-10k'
                        ? '1k–10k'
                        : b}
                  </button>
                );
              })}
            </div>
          </div>
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
            onClick={() => {
              // Ensure defaults are mirrored before planner runs.
              if (picked === 'launching' && !launchDate) {
                onChange({
                  productState: 'launching',
                  launchDate: defaultLaunchDate(),
                  launchChannel: launchChannel ?? 'producthunt',
                });
              } else if (picked === 'launched' && !launchedAt) {
                onChange({
                  productState: 'launched',
                  launchedAt: defaultLaunchedAt(),
                });
              } else if (picked !== productState) {
                onChange({ productState: picked as ProductState });
              }
              onGeneratePlan();
            }}
          >
            {COPY.stage5.generateCta}
            <ArrowRight size={14} />
          </OnbButton>
        }
      />
    </div>
  );
}
