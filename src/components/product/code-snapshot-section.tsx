'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { GitHubRepoSelector } from '@/components/onboarding/github-repo-selector';
import { useToast } from '@/components/ui/toast';
import type { TechStack } from '@/types/code-scanner';
import type { ExtractedProfile } from '@/types/onboarding';

interface SnapshotData {
  repoFullName: string;
  repoUrl: string;
  techStack: TechStack;
  scanSummary: string | null;
  commitSha: string | null;
  scannedAt: string;
}

interface CodeSnapshotSectionProps {
  snapshot: SnapshotData | null;
  hasGitHub: boolean;
}

export function CodeSnapshotSection({ snapshot, hasGitHub }: CodeSnapshotSectionProps) {
  const [scanState, setScanState] = useState<'idle' | 'scanning'>('idle');
  const [progress, setProgress] = useState<{ phase: string; message: string } | null>(null);
  const [showRepoSelector, setShowRepoSelector] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const { toast } = useToast();

  const saveExtracted = async (data: ExtractedProfile) => {
    const res = await fetch('/api/onboarding/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.name,
        description: data.description,
        keywords: data.keywords,
        valueProp: data.valueProp,
        merge: true,
      }),
    });
    if (!res.ok) throw new Error('Failed to save updated profile');
  };

  const handleRescan = async () => {
    if (!snapshot) return;
    setScanState('scanning');
    setProgress({ phase: 'queuing', message: 'Starting scan...' });
    setError('');

    try {
      const res = await fetch('/api/onboarding/extract-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoFullName: snapshot.repoFullName }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to start scan');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6);

          try {
            const event = JSON.parse(json);
            if (event.type === 'progress') {
              setProgress({ phase: event.phase, message: event.message });
            } else if (event.type === 'complete') {
              await saveExtracted(event.data);
              toast('Code snapshot updated');
              router.refresh();
              return;
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== json) {
              throw parseErr;
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanState('idle');
      setProgress(null);
    }
  };

  const handleRepoSelected = async (data: ExtractedProfile) => {
    setShowRepoSelector(false);
    try {
      await saveExtracted(data);
      toast('Product updated from GitHub');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleRemove = async () => {
    setRemoveOpen(false);
    setRemoving(true);
    setError('');

    try {
      const res = await fetch('/api/product/code-snapshot', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove');
      toast('Code snapshot removed');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setRemoving(false);
    }
  };

  // No snapshot, no GitHub account
  if (!snapshot && !hasGitHub) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Code Snapshot</h2>
        <Card>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary">
            Connect your GitHub account in{' '}
            <a href="/settings" className="text-sf-accent hover:underline">Settings</a>
            {' '}to import code snapshots.
          </p>
        </Card>
      </section>
    );
  }

  // No snapshot, has GitHub
  if (!snapshot) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Code Snapshot</h2>
        <Card className="flex flex-col items-center py-6">
          <GitHubIcon />
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mt-2">
            Import from your GitHub repository to extract tech stack and product details.
          </p>
          <Button
            variant="ghost"
            className="mt-3 !min-h-[36px] !text-[14px] !tracking-[-0.224px]"
            onClick={() => setShowRepoSelector(true)}
          >
            Import from GitHub
          </Button>
        </Card>
        {showRepoSelector && (
          <Dialog open={showRepoSelector} onClose={() => setShowRepoSelector(false)} title="Select repository">
            <GitHubRepoSelector
              onExtracted={handleRepoSelected}
              onBack={() => setShowRepoSelector(false)}
            />
          </Dialog>
        )}
      </section>
    );
  }

  // Snapshot exists
  return (
    <section>
      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Code Snapshot</h2>
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitHubIcon />
            <a
              href={snapshot.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary hover:text-sf-accent transition-colors duration-200"
            >
              {snapshot.repoFullName}
            </a>
          </div>
          {snapshot.commitSha && (
            <Badge mono>{snapshot.commitSha.slice(0, 7)}</Badge>
          )}
        </div>

        <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-1">
          Last scanned {formatRelativeTime(snapshot.scannedAt)}
        </p>

        {/* Tech Stack */}
        <div className="mt-4 flex flex-col gap-2">
          {snapshot.techStack.languages.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary w-20 shrink-0">Languages</span>
              {snapshot.techStack.languages.map((l) => (
                <Badge key={l} variant="accent">{l}</Badge>
              ))}
            </div>
          )}
          {snapshot.techStack.frameworks.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary w-20 shrink-0">Frameworks</span>
              {snapshot.techStack.frameworks.map((f) => (
                <Badge key={f}>{f}</Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary w-20 shrink-0">Tooling</span>
            {snapshot.techStack.hasTests && <Badge variant="success">Tests</Badge>}
            {snapshot.techStack.hasCi && <Badge variant="success">CI</Badge>}
            {snapshot.techStack.hasDocker && <Badge variant="success">Docker</Badge>}
            {!snapshot.techStack.hasTests && <Badge>No Tests</Badge>}
            {!snapshot.techStack.hasCi && <Badge>No CI</Badge>}
          </div>
        </div>

        {snapshot.scanSummary && (
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mt-3 leading-relaxed">
            {snapshot.scanSummary}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-4 pt-4 border-t border-[rgba(0,0,0,0.08)]">
          <Button
            variant="ghost"
            className="!min-h-[36px] !text-[14px] !tracking-[-0.224px] !px-3"
            onClick={handleRescan}
            disabled={scanState !== 'idle'}
          >
            {scanState === 'scanning' ? 'Scanning...' : 'Re-scan repo'}
          </Button>
          <Button
            variant="ghost"
            className="!min-h-[36px] !text-[14px] !tracking-[-0.224px] !px-3"
            onClick={() => setShowRepoSelector(true)}
            disabled={scanState !== 'idle'}
          >
            Change repo
          </Button>
          <Button
            variant="ghost"
            className="!min-h-[36px] !text-[14px] !tracking-[-0.224px] !px-3 ml-auto text-sf-text-tertiary"
            onClick={() => setRemoveOpen(true)}
            disabled={scanState !== 'idle' || removing}
          >
            {removing ? 'Removing...' : 'Remove'}
          </Button>
        </div>

        {/* Progress */}
        {scanState === 'scanning' && progress && (
          <div className="flex items-center gap-2 mt-3">
            <div className="w-4 h-4 border-2 border-sf-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">{progress.message}</p>
          </div>
        )}

        {error && <p className="text-[14px] tracking-[-0.224px] text-sf-error mt-2">{error}</p>}
      </Card>

      {showRepoSelector && (
        <Dialog open={showRepoSelector} onClose={() => setShowRepoSelector(false)} title="Select repository">
          <GitHubRepoSelector
            onExtracted={handleRepoSelected}
            onBack={() => setShowRepoSelector(false)}
          />
        </Dialog>
      )}

      <AlertDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={handleRemove}
        title="Remove code snapshot?"
        description="The stored repo scan and tech stack will be cleared. You can re-import from GitHub any time."
        confirmLabel="Remove"
        destructive
        confirmDisabled={removing}
      />
    </section>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-sf-text-primary shrink-0">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
