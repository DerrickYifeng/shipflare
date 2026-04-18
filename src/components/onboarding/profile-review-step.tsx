'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { ExtractedProfile } from '@/types/onboarding';

interface ProfileReviewStepProps {
  profile: ExtractedProfile;
  onSaved: () => void;
  onBack: () => void;
}

export function ProfileReviewStep({ profile, onSaved, onBack }: ProfileReviewStepProps) {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [keywords, setKeywords] = useState(profile.keywords.join(', '));
  const [valueProp, setValueProp] = useState(profile.valueProp);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/onboarding/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: profile.url,
          name,
          description,
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          valueProp,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to save profile');
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
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
        helper="Comma-separated. These help us find relevant Reddit threads."
      />

      <Input
        label="Value proposition"
        value={valueProp}
        onChange={(e) => setValueProp(e.target.value)}
        helper="One sentence: what does your product do for users?"
      />

      {error && <p className="text-[14px] tracking-[-0.224px] text-sf-error">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading || !name || !description}>
          {loading ? 'Saving...' : 'Save and continue'}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}
