'use client';

import { useState } from 'react';
import { usePreferences, type Preferences } from '@/hooks/use-preferences';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

const UTC_HOURS = Array.from({ length: 24 }, (_, i) => i);
const DRAFT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'reply', label: 'Reply' },
  { value: 'original_post', label: 'Original Post' },
];

function formatHourLocal(utcHour: number): string {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AutomationSection() {
  const { preferences, isLoading, update } = usePreferences();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  // Local draft state for edits
  const [draft, setDraft] = useState<Partial<Preferences>>({});

  if (isLoading || !preferences) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Automation</h2>
        <Skeleton className="h-64 w-full" />
      </section>
    );
  }

  // Merged view: draft overrides preferences
  const merged = { ...preferences, ...draft };
  const hasChanges = Object.keys(draft).length > 0;

  const patch = (field: keyof Preferences, value: Preferences[keyof Preferences]) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!hasChanges) return;
    setSaving(true);
    try {
      await update(draft);
      setDraft({});
      toast('Preferences saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const mixTotal =
    merged.contentMixMetric +
    merged.contentMixEducational +
    merged.contentMixEngagement +
    merged.contentMixProduct;

  return (
    <section>
      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Automation</h2>

      <div className="flex flex-col gap-6 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] rounded-[var(--radius-sf-lg)] p-5">
        {/* Auto-approve */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">Auto-approve</h3>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
                Automatically approve high-scoring drafts
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={merged.autoApproveEnabled}
                onChange={(e) => patch('autoApproveEnabled', e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-sf-bg-tertiary rounded-full peer peer-checked:bg-sf-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-4" />
            </label>
          </div>

          {merged.autoApproveEnabled && (
            <div className="flex flex-col gap-3 pl-1 animate-sf-fade-in">
              {/* Threshold slider */}
              <div>
                <label className="text-[12px] tracking-[-0.12px] text-sf-text-secondary mb-1 block">
                  Minimum score: {Math.round(merged.autoApproveThreshold * 100)}%
                </label>
                <input
                  type="range"
                  min="50"
                  max="100"
                  value={Math.round(merged.autoApproveThreshold * 100)}
                  onChange={(e) => patch('autoApproveThreshold', Number(e.target.value) / 100)}
                  className="w-full accent-sf-accent"
                />
              </div>

              {/* Allowed types */}
              <div>
                <label className="text-[12px] tracking-[-0.12px] text-sf-text-secondary mb-1 block">
                  Allowed draft types
                </label>
                <div className="flex gap-2">
                  {DRAFT_TYPES.map((dt) => {
                    const checked = merged.autoApproveTypes.includes(dt.value);
                    return (
                      <label key={dt.value} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...merged.autoApproveTypes, dt.value]
                              : merged.autoApproveTypes.filter((t) => t !== dt.value);
                            if (next.length > 0) patch('autoApproveTypes', next);
                          }}
                          className="accent-sf-accent"
                        />
                        <span className="text-[14px] tracking-[-0.224px] text-sf-text-primary">{dt.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Max per day */}
              <div>
                <label className="text-[12px] tracking-[-0.12px] text-sf-text-secondary mb-1 block">
                  Max auto-approvals per day
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={merged.maxAutoApprovalsPerDay}
                  onChange={(e) => patch('maxAutoApprovalsPerDay', Number(e.target.value))}
                  className="w-20 px-2 py-1 text-[14px] tracking-[-0.224px] bg-[#f5f5f7] border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] text-sf-text-primary"
                />
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-[rgba(0,0,0,0.08)]" />

        {/* Posting hours */}
        <div>
          <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary mb-1">Posting hours (UTC)</h3>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-3">
            Select 1-6 hours for scheduled content
          </p>
          <div className="flex flex-wrap gap-1.5">
            {UTC_HOURS.map((h) => {
              const selected = merged.postingHoursUtc.includes(h);
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => {
                    const next = selected
                      ? merged.postingHoursUtc.filter((x) => x !== h)
                      : [...merged.postingHoursUtc, h].sort((a, b) => a - b);
                    if (next.length >= 1 && next.length <= 6) {
                      patch('postingHoursUtc', next);
                    }
                  }}
                  className={`w-10 h-8 rounded-[var(--radius-sf-md)] text-[12px] tracking-[-0.12px] font-mono transition-colors duration-200 ${
                    selected
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-bg-secondary text-sf-text-tertiary hover:text-sf-text-primary'
                  }`}
                  title={formatHourLocal(h)}
                >
                  {String(h).padStart(2, '0')}
                </button>
              );
            })}
          </div>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-1.5">
            Selected: {merged.postingHoursUtc.map((h) => formatHourLocal(h)).join(', ')}
          </p>
        </div>

        {/* Divider */}
        <div className="border-t border-[rgba(0,0,0,0.08)]" />

        {/* Content mix */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">Content mix</h3>
            <Badge variant={mixTotal === 100 ? 'success' : 'error'} mono>
              {mixTotal}%
            </Badge>
          </div>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-3">
            Ratios for calendar content generation (must sum to 100)
          </p>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['contentMixMetric', 'Metric'],
              ['contentMixEducational', 'Educational'],
              ['contentMixEngagement', 'Engagement'],
              ['contentMixProduct', 'Product'],
            ] as const).map(([key, label]) => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-[14px] tracking-[-0.224px] text-sf-text-secondary w-24">{label}</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={merged[key]}
                  onChange={(e) => patch(key, Number(e.target.value))}
                  className="w-16 px-2 py-1 text-[14px] tracking-[-0.224px] bg-[#f5f5f7] border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] text-sf-text-primary text-right"
                />
                <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-[rgba(0,0,0,0.08)]" />

        {/* Notifications */}
        <div>
          <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary mb-3">Notifications</h3>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[14px] tracking-[-0.224px] text-sf-text-secondary">Notify on new draft</span>
              <input
                type="checkbox"
                checked={merged.notifyOnNewDraft}
                onChange={(e) => patch('notifyOnNewDraft', e.target.checked)}
                className="accent-sf-accent"
              />
            </label>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[14px] tracking-[-0.224px] text-sf-text-secondary">Notify on auto-approve</span>
              <input
                type="checkbox"
                checked={merged.notifyOnAutoApprove}
                onChange={(e) => patch('notifyOnAutoApprove', e.target.checked)}
                className="accent-sf-accent"
              />
            </label>
          </div>
        </div>

        {/* Save */}
        {hasChanges && (
          <div className="flex items-center gap-3 pt-2 animate-sf-fade-in">
            <Button onClick={handleSave} disabled={saving || mixTotal !== 100}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
            <Button variant="ghost" onClick={() => setDraft({})}>
              Discard
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
