'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ExtractedProfile {
  url: string;
  name: string;
  description: string;
  keywords: string[];
  valueProp: string;
  ogImage: string | null;
  seoAudit: Record<string, unknown> | null;
}

interface UrlInputStepProps {
  onExtracted: (data: ExtractedProfile) => void;
}

export function UrlInputStep({ onExtracted }: UrlInputStepProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/onboarding/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to extract profile');
      }

      const data = await res.json();
      onExtracted(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleManual = () => {
    onExtracted({
      url: url || 'https://example.com',
      name: '',
      description: '',
      keywords: [],
      valueProp: '',
      ogImage: null,
      seoAudit: null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <Input
        label="Product URL"
        placeholder="https://your-product.com"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={error}
        helper="We'll extract your product name, description, and keywords automatically."
        required
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading || !url}>
          {loading ? 'Extracting...' : 'Extract profile'}
        </Button>
        <Button type="button" variant="ghost" onClick={handleManual}>
          Enter manually
        </Button>
      </div>
    </form>
  );

}
