'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

const PHASE_CONFIG = {
  pre_launch: { label: 'Pre-Launch', description: 'Building & validating', variant: 'warning' as const },
  launched: { label: 'Launched', description: 'Live with real users', variant: 'success' as const },
  scaling: { label: 'Scaling', description: 'Growing & expanding', variant: 'accent' as const },
} as const;

type LifecyclePhase = keyof typeof PHASE_CONFIG;

interface ProductData {
  name: string;
  description: string;
  keywords: string[];
  valueProp: string | null;
  lifecyclePhase: string;
}

interface ProductInfoSectionProps {
  product: ProductData;
}

export function ProductInfoSection({ product }: ProductInfoSectionProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description);
  const [keywords, setKeywords] = useState(product.keywords.join(', '));
  const [valueProp, setValueProp] = useState(product.valueProp ?? '');
  const [phase, setPhase] = useState<LifecyclePhase>(
    (product.lifecyclePhase as LifecyclePhase) || 'pre_launch',
  );
  const [savingPhase, setSavingPhase] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const { toast } = useToast();

  const handlePhaseChange = async (newPhase: LifecyclePhase) => {
    if (newPhase === phase) return;
    setSavingPhase(true);
    setError('');

    try {
      const res = await fetch('/api/product/phase', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lifecyclePhase: newPhase }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to update phase');
      }

      setPhase(newPhase);
      toast(`Phase updated to ${PHASE_CONFIG[newPhase].label}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update phase');
    } finally {
      setSavingPhase(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      const res = await fetch('/api/onboarding/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          valueProp: valueProp || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to save');
      }

      toast('Product updated');
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Clear all product info? Fields will be reset to empty.')) return;
    setResetting(true);
    setError('');

    try {
      const res = await fetch('/api/onboarding/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Untitled Product',
          description: '-',
          keywords: [],
          valueProp: '',
        }),
      });

      if (!res.ok) throw new Error('Failed to reset');
      toast('Product info cleared');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setResetting(false);
    }
  };

  const handleCancel = () => {
    setName(product.name);
    setDescription(product.description);
    setKeywords(product.keywords.join(', '));
    setValueProp(product.valueProp ?? '');
    setPhase((product.lifecyclePhase as LifecyclePhase) || 'pre_launch');
    setError('');
    setEditing(false);
  };

  if (editing) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Edit Product</h2>
        <Card>
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <Input
              label="Product name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <div className="flex flex-col gap-1.5">
              <label className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                required
                className="
                  w-full px-3 py-2
                  rounded-[var(--radius-sf-md)]
                  border border-[rgba(0,0,0,0.08)] text-[17px] tracking-[-0.374px] text-sf-text-primary
                  bg-sf-bg-secondary placeholder:text-sf-text-tertiary
                  hover:border-sf-text-tertiary focus:border-sf-accent
                  transition-colors duration-200 resize-none
                "
              />
            </div>

            <Input
              label="Keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              helper="Comma-separated. These help find relevant threads."
            />

            <Input
              label="Value proposition"
              value={valueProp}
              onChange={(e) => setValueProp(e.target.value)}
              helper="One sentence: what does your product do for users?"
            />

            {error && <p className="text-[14px] tracking-[-0.224px] text-sf-error">{error}</p>}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !name || !description}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
              <Button type="button" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary">Product Info</h2>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="!min-h-[32px] !text-[14px] !tracking-[-0.224px] !px-3"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            className="!min-h-[32px] !text-[14px] !tracking-[-0.224px] !px-3 text-sf-text-tertiary"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? 'Clearing...' : 'Reset'}
          </Button>
        </div>
      </div>

      <Card>
        <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary">{product.name}</p>

        <div className="flex gap-1 mt-3" role="radiogroup" aria-label="Product lifecycle phase">
          {(Object.entries(PHASE_CONFIG) as [LifecyclePhase, typeof PHASE_CONFIG[LifecyclePhase]][]).map(
            ([key, config]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={phase === key}
                disabled={savingPhase}
                onClick={() => handlePhaseChange(key)}
                className={`
                  px-2.5 py-1 rounded-[var(--radius-sf-sm)]
                  text-[12px] font-medium leading-4 tracking-[-0.12px]
                  transition-all duration-200 cursor-pointer
                  ${phase === key
                    ? key === 'pre_launch'
                      ? 'bg-sf-warning-light text-[#c67a05] ring-1 ring-[#c67a05]/20'
                      : key === 'launched'
                        ? 'bg-sf-success-light text-[#248a3d] ring-1 ring-[#248a3d]/20'
                        : 'bg-sf-accent-light text-sf-accent ring-1 ring-sf-accent/20'
                    : 'bg-transparent text-sf-text-tertiary hover:text-sf-text-secondary hover:bg-black/[0.03]'
                  }
                  ${savingPhase ? 'opacity-60' : ''}
                `}
              >
                {config.label}
              </button>
            ),
          )}
        </div>

        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mt-3 leading-[1.47]">
          {product.description}
        </p>

        {product.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {product.keywords.map((kw) => (
              <Badge key={kw}>{kw}</Badge>
            ))}
          </div>
        )}

        {product.valueProp && (
          <div className="mt-3 pl-3 border-l-2 border-sf-accent/30">
            <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary italic">{product.valueProp}</p>
          </div>
        )}

        {error && <p className="text-[14px] tracking-[-0.224px] text-sf-error mt-3">{error}</p>}
      </Card>
    </section>
  );
}
