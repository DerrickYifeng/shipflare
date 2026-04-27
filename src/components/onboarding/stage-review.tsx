// Stage 3 — Profile review. 6 fields revealed staggered, 90ms apart.
// Autosaves to the Redis draft via PUT /api/onboarding/draft (debounced 400ms
// during typing so we don't flood the endpoint).

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { OnbButton } from './_shared/onb-button';
import { OnbInput } from './_shared/onb-input';
import { OnbTextarea } from './_shared/onb-textarea';
import { Field } from './_shared/field';
import { FieldReveal } from './_shared/field-reveal';
import { KeywordEditor } from './_shared/keyword-editor';
import { CategoryPicker } from './_shared/category-picker';
import { ArrowRight, Check, GitHub, Globe } from './icons';
import { COPY } from './_copy';
import type { ProductCategory } from './OnboardingFlow';

export interface StageReviewValue {
  name: string;
  description: string;
  audience: string;
  keywords: string[];
  category: ProductCategory;
}

interface StageReviewProps {
  initialValue: StageReviewValue;
  /** For the "Extracted from {source}" chip. Omitted when manual-entry. */
  sourceKind: 'github' | 'url' | 'manual' | 'url-only';
  sourceLabel: string;
  onBack: () => void;
  onContinue: (value: StageReviewValue) => void;
  /** Called after 400ms debounce when any text field changes. */
  onAutoSave?: (value: StageReviewValue) => void;
}

export function StageReview({
  initialValue,
  sourceKind,
  sourceLabel,
  onBack,
  onContinue,
  onAutoSave,
}: StageReviewProps) {
  const [value, setValue] = useState<StageReviewValue>(initialValue);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    const t = setInterval(
      () => setRevealed((r) => (r >= 6 ? r : r + 1)),
      90,
    );
    return () => clearInterval(t);
  }, []);

  // Debounced autosave.
  const autoSaveRef = useRef(onAutoSave);
  useEffect(() => {
    autoSaveRef.current = onAutoSave;
  });
  useEffect(() => {
    if (!autoSaveRef.current) return;
    const t = setTimeout(() => autoSaveRef.current?.(value), 400);
    return () => clearTimeout(t);
  }, [value]);

  const update = useCallback(<K extends keyof StageReviewValue>(
    key: K,
    next: StageReviewValue[K],
  ) => {
    setValue((prev) => ({ ...prev, [key]: next }));
  }, []);

  const canContinue =
    value.name.trim().length > 0 && value.description.trim().length > 0;

  const sourceChip: ReactNode =
    sourceKind === 'manual' || sourceKind === 'url-only'
      ? null
      : (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              borderRadius: 980,
              background: 'rgba(52,199,89,0.10)',
              color: 'var(--sf-success-ink)',
              fontSize: 11,
              fontFamily: 'var(--sf-font-mono)',
              letterSpacing: '-0.08px',
              textTransform: 'uppercase',
              fontWeight: 500,
              verticalAlign: 'middle',
              marginLeft: 6,
            }}
          >
            <Check size={10} /> {COPY.stage3.extractedFrom}{' '}
            {sourceKind === 'github' ? (
              <GitHub size={12} />
            ) : (
              <Globe size={12} />
            )}{' '}
            {sourceLabel}
          </span>
        );

  const sub = useMemo(
    () => (
      <>
        {COPY.stage3.subPrefix}
        {sourceChip}
      </>
    ),
    [sourceChip],
  );

  return (
    <div>
      <StepHeader
        kicker={COPY.stage3.kicker}
        title={COPY.stage3.title}
        sub={sub}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <FieldReveal shown={revealed >= 1}>
          <Field
            label={COPY.stage3.fields.name.label}
            hint={COPY.stage3.fields.name.hint}
            required
          >
            <OnbInput
              value={value.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="ShipFlare"
            />
          </Field>
        </FieldReveal>

        <FieldReveal shown={revealed >= 2}>
          <Field
            label={COPY.stage3.fields.description.label}
            hint={COPY.stage3.fields.description.hint}
            required
          >
            <OnbTextarea
              value={value.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="AI marketing autopilot for indie developers…"
              rows={4}
            />
          </Field>
        </FieldReveal>

        <FieldReveal shown={revealed >= 3}>
          <Field
            label={COPY.stage3.fields.audience.label}
            hint={COPY.stage3.fields.audience.hint}
          >
            <OnbInput
              value={value.audience}
              onChange={(e) => update('audience', e.target.value)}
              placeholder="Indie developers, engineering leads"
            />
          </Field>
        </FieldReveal>

        <FieldReveal shown={revealed >= 4}>
          <Field
            label={COPY.stage3.fields.keywords.label}
            hint={COPY.stage3.fields.keywords.hint}
          >
            <KeywordEditor
              keywords={value.keywords}
              onChange={(next) => update('keywords', next)}
              placeholderEmpty={COPY.stage3.keywordAddPlaceholder}
              placeholderMore={COPY.stage3.keywordAddMorePlaceholder}
            />
          </Field>
        </FieldReveal>

        <FieldReveal shown={revealed >= 5}>
          <Field
            label={COPY.stage3.fields.category.label}
            hint={COPY.stage3.fields.category.hint}
          >
            <CategoryPicker
              value={value.category}
              onChange={(next) => update('category', next)}
              options={COPY.stage3.categoryOptions}
            />
          </Field>
        </FieldReveal>

        <FieldReveal shown={revealed >= 6}>
          <div
            style={{
              marginTop: 4,
              padding: '12px 14px',
              background: 'var(--sf-bg-primary)',
              borderRadius: 10,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'var(--sf-accent)',
                marginTop: 8,
                flexShrink: 0,
              }}
            />
            <div
              style={{
                fontSize: 13,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-2)',
                lineHeight: 1.47,
              }}
            >
              <span style={{ color: 'var(--sf-fg-1)', fontWeight: 500 }}>
                {COPY.stage3.whatHappensNext}
              </span>
              {COPY.stage3.whatHappensNextDetail}
            </div>
          </div>
        </FieldReveal>
      </div>

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
            disabled={!canContinue}
            onClick={() =>
              onContinue({
                ...value,
                name: value.name.trim(),
                description: value.description.trim(),
                audience: value.audience.trim(),
              })
            }
          >
            {COPY.stage3.continueCta}
            <ArrowRight size={14} />
          </OnbButton>
        }
      />
    </div>
  );
}
