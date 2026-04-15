'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { GitHubRepoSelector } from './github-repo-selector';
import type { ExtractedProfile } from '@/types/onboarding';

type Method = 'choose' | 'github' | 'url';

interface ProductSourceStepProps {
  onExtracted: (data: ExtractedProfile) => void;
}

export function ProductSourceStep({ onExtracted }: ProductSourceStepProps) {
  const [method, setMethod] = useState<Method>('choose');

  if (method === 'github') {
    return (
      <GitHubRepoSelector
        onExtracted={onExtracted}
        onBack={() => setMethod('choose')}
      />
    );
  }

  if (method === 'url') {
    return (
      <UrlInputForm
        onExtracted={onExtracted}
        onBack={() => setMethod('choose')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[17px] tracking-[-0.374px] text-sf-text-secondary leading-[1.47]">
        We&apos;ll scan your product to extract name, description, and keywords automatically.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {/* GitHub Repo */}
        <button
          type="button"
          onClick={() => setMethod('github')}
          className="
            flex flex-col items-start gap-2 p-4
            bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] rounded-[var(--radius-sf-lg)]
            hover:shadow-[0_3px_8px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.08)]
            transition-all duration-200 text-left
          "
        >
          <div className="w-8 h-8 bg-sf-bg-tertiary rounded-[var(--radius-sf-md)] flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-sf-text-primary" aria-hidden="true">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </div>
          <div>
            <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">
              Import from GitHub
            </p>
            <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
              Scan your code to understand your product
            </p>
          </div>
        </button>

        {/* Website URL */}
        <button
          type="button"
          onClick={() => setMethod('url')}
          className="
            flex flex-col items-start gap-2 p-4
            bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] rounded-[var(--radius-sf-lg)]
            hover:shadow-[0_3px_8px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.08)]
            transition-all duration-200 text-left
          "
        >
          <div className="w-8 h-8 bg-sf-bg-tertiary rounded-[var(--radius-sf-md)] flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sf-text-primary" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <div>
            <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">
              From website URL
            </p>
            <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
              We&apos;ll scan your homepage for details
            </p>
          </div>
        </button>
      </div>

      <button
        type="button"
        onClick={() =>
          onExtracted({
            url: '',
            name: '',
            description: '',
            keywords: [],
            valueProp: '',
            ogImage: null,
            seoAudit: null,
          })
        }
        className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary hover:text-sf-text-secondary transition-colors duration-200 self-start"
      >
        or enter manually &rarr;
      </button>
    </div>
  );
}

// ─── URL Input Sub-form ─────────────────────────────────────

interface UrlInputFormProps {
  onExtracted: (data: ExtractedProfile) => void;
  onBack: () => void;
}

function UrlInputForm({ onExtracted, onBack }: UrlInputFormProps) {
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <Input
        label="Product URL"
        placeholder="https://your-product.com"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={error}
        helper="We'll scan your page and extract product details automatically."
        required
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading || !url}>
          {loading ? 'Scanning...' : 'Scan website'}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}
