'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { SeoAuditSection } from './seo-audit-section';
import type { SeoAuditResult } from '@/tools/seo-audit';

interface WebsiteInfoSectionProps {
  url: string | null;
  seoAudit: SeoAuditResult | null;
}

export function WebsiteInfoSection({ url, seoAudit }: WebsiteInfoSectionProps) {
  const [inputUrl, setInputUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const { toast } = useToast();

  const scanAndSave = async (targetUrl: string) => {
    const extractRes = await fetch('/api/onboarding/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });

    if (!extractRes.ok) {
      const data = await extractRes.json();
      throw new Error(data.error ?? 'Failed to scan website');
    }

    const extracted = await extractRes.json();

    const saveRes = await fetch('/api/onboarding/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: extracted.url || targetUrl,
        name: extracted.name,
        description: extracted.description,
        keywords: extracted.keywords,
        valueProp: extracted.valueProp,
        merge: true,
      }),
    });

    if (!saveRes.ok) throw new Error('Failed to save updated profile');
  };

  const handleAddWebsite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setScanning(true);

    try {
      await scanAndSave(inputUrl);
      toast('Website added and product info updated');
      setInputUrl('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const handleRescan = async () => {
    if (!url) return;
    setRescanning(true);
    setError('');

    try {
      await scanAndSave(url);
      toast('Website re-scanned, product info updated');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-scan failed');
    } finally {
      setRescanning(false);
    }
  };

  const handleRemove = async () => {
    setRemoveOpen(false);
    setRemoving(true);
    setError('');

    try {
      const res = await fetch('/api/product/website', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove');
      toast('Website info removed');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setRemoving(false);
    }
  };

  // No website — show empty state with explicit Add CTA. We intentionally
  // do NOT fall back to a repo URL here; the SEO audit and discovery queries
  // should draw from the product's real homepage copy, not a README.
  if (!url) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">
          Website
        </h2>
        <Card>
          <div className="flex flex-col items-center text-center py-6 gap-4">
            <div className="w-12 h-12 rounded-full bg-sf-bg-secondary flex items-center justify-center">
              <WebIcon />
            </div>
            <div className="flex flex-col gap-1 max-w-sm">
              <p className="text-[15px] tracking-[-0.24px] font-medium text-sf-text-primary">
                No website connected
              </p>
              <p className="text-[13px] tracking-[-0.16px] text-sf-text-tertiary leading-[1.5]">
                Add your product homepage so ShipFlare can anchor replies and
                recommendations to what it actually does — not a code repo.
              </p>
            </div>
            <form
              onSubmit={handleAddWebsite}
              className="flex flex-col gap-3 w-full max-w-sm"
            >
              <Input
                label="Product URL"
                placeholder="https://your-product.com"
                type="url"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                helper="We'll scan your page and update product details automatically."
                required
              />
              {error && (
                <p className="text-[14px] tracking-[-0.224px] text-sf-error">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={scanning || !inputUrl}>
                {scanning ? 'Scanning...' : 'Add website'}
              </Button>
            </form>
          </div>
        </Card>
      </section>
    );
  }

  // Website exists — show URL + SEO + actions
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary">Website</h2>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            className="!min-h-[32px] !text-[14px] !tracking-[-0.224px] !px-3"
            onClick={handleRescan}
            disabled={rescanning || removing}
          >
            {rescanning ? 'Scanning...' : 'Re-scan'}
          </Button>
          <Button
            variant="ghost"
            className="!min-h-[32px] !text-[14px] !tracking-[-0.224px] !px-3 text-sf-text-tertiary"
            onClick={() => setRemoveOpen(true)}
            disabled={rescanning || removing}
          >
            {removing ? 'Removing...' : 'Remove'}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={handleRemove}
        title="Remove website info?"
        description="The URL and SEO audit data will be cleared. You can add a website again any time."
        confirmLabel="Remove"
        destructive
        confirmDisabled={removing}
      />

      <Card>
        <div className="flex items-center gap-2">
          <WebIcon />
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[14px] tracking-[-0.224px] font-medium text-sf-accent hover:underline"
          >
            {url}
          </a>
        </div>
        {error && <p className="text-[14px] tracking-[-0.224px] text-sf-error mt-2">{error}</p>}
      </Card>

      <div className="mt-4">
        <SeoAuditSection audit={seoAudit} />
      </div>
    </section>
  );
}

function WebIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sf-text-secondary shrink-0">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
