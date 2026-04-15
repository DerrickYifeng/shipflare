'use client';

import { useState } from 'react';
import { usePreferences } from '@/hooks/use-preferences';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Toronto', label: 'Eastern Time (Canada)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris / Berlin' },
  { value: 'Europe/Helsinki', label: 'Helsinki' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Shanghai', label: 'Shanghai / Beijing' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Australia/Melbourne', label: 'Melbourne' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
];

export function TimezoneSection() {
  const { preferences, isLoading, update } = usePreferences();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  if (isLoading || !preferences) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">
          Timezone
        </h2>
        <Skeleton className="h-12 w-full" />
      </section>
    );
  }

  const current = selected ?? preferences.timezone;
  const hasChanged = selected !== null && selected !== preferences.timezone;

  const handleSave = async () => {
    if (!hasChanged) return;
    setSaving(true);
    try {
      await update({ timezone: selected! });
      setSelected(null);
      toast('Timezone updated', 'success');
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Failed to save timezone', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-1">
        Timezone
      </h2>
      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-4 leading-[1.47]">
        Your daily todo list is generated at 8 AM in your local timezone.
      </p>

      <div className="flex items-center gap-3">
        <select
          value={current}
          onChange={(e) => setSelected(e.target.value)}
          className="flex-1 h-10 px-3 bg-[#f5f5f7] border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] text-[14px] tracking-[-0.224px] text-sf-text-primary focus:outline-none focus:ring-1 focus:ring-sf-accent transition-colors duration-200"
        >
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label} ({tz.value})
            </option>
          ))}
        </select>

        {hasChanged && (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        )}
      </div>
    </section>
  );
}
