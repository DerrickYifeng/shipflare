'use client';

import { useState, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { GitHubRepo } from '@/types/code-scanner';
import type { ExtractedProfile } from '@/types/onboarding';

interface GitHubRepoSelectorProps {
  onExtracted: (data: ExtractedProfile) => void;
  onBack: () => void;
}

type ScanPhase = 'idle' | 'loading-repos' | 'scanning' | 'error';

interface ScanProgress {
  phase: string;
  message: string;
}

export function GitHubRepoSelector({ onExtracted, onBack }: GitHubRepoSelectorProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState<ScanPhase>('loading-repos');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  // Fetch repos on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchRepos() {
      try {
        const res = await fetch('/api/onboarding/github-repos');
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Failed to fetch repos');
        }
        const data = await res.json();
        if (!cancelled) {
          setRepos(data.repos);
          setPhase('idle');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load repos');
          setPhase('error');
        }
      }
    }

    fetchRepos();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!search) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [repos, search]);

  const handleSelect = async (repo: GitHubRepo) => {
    setSelected(repo.fullName);
    setPhase('scanning');
    setProgress({ phase: 'queuing', message: 'Starting scan...' });
    setError('');

    try {
      const res = await fetch('/api/onboarding/extract-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoFullName: repo.fullName }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to start scan');
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      const processLines = (lines: string[]) => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const json = trimmed.slice(6);

          try {
            const event = JSON.parse(json);

            if (event.type === 'progress') {
              setProgress({ phase: event.phase, message: event.message });
            } else if (event.type === 'complete') {
              onExtracted(event.data);
              return true;
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== json) {
              throw parseErr;
            }
          }
        }
        return false;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        if (processLines(lines)) return;
      }

      // Process any remaining buffered data after stream closes
      if (buffer.trim()) {
        if (processLines([buffer])) return;
      }

      // Stream ended without complete/error — treat as failure
      throw new Error('Scan stream ended unexpectedly. Please try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
      setPhase('error');
      setSelected(null);
    }
  };

  if (phase === 'loading-repos') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="w-5 h-5 border-2 border-sf-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-[13px] text-sf-text-secondary">Loading your repos...</p>
      </div>
    );
  }

  if (phase === 'scanning') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="w-5 h-5 border-2 border-sf-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-[13px] font-medium text-sf-text-primary">
          Scanning {selected}
        </p>
        {progress && (
          <p className="text-[12px] text-sf-text-tertiary">{progress.message}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Input
        placeholder="Search repos..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {error && <p className="text-[13px] text-sf-error">{error}</p>}

      <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto -mx-1 px-1">
        {filtered.length === 0 && (
          <p className="text-[13px] text-sf-text-tertiary py-4 text-center">
            {search ? 'No repos match your search' : 'No public repos found'}
          </p>
        )}
        {filtered.map((repo) => (
          <button
            key={repo.fullName}
            type="button"
            onClick={() => handleSelect(repo)}
            className="
              flex items-start gap-3 p-3 text-left
              rounded-[var(--radius-sf-md)]
              border border-transparent
              hover:border-sf-border hover:bg-sf-bg-secondary
              transition-colors duration-150
            "
          >
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-sf-text-primary truncate">
                {repo.name}
              </p>
              {repo.description && (
                <p className="text-[11px] text-sf-text-tertiary mt-0.5 line-clamp-1">
                  {repo.description}
                </p>
              )}
            </div>
            {repo.language && (
              <span className="text-[10px] text-sf-text-tertiary bg-sf-bg-tertiary px-1.5 py-0.5 rounded shrink-0">
                {repo.language}
              </span>
            )}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-sf-text-tertiary">
        Showing public repos only, sorted by recent activity.
      </p>

      <Button variant="ghost" onClick={onBack} className="self-start">
        Back
      </Button>
    </div>
  );
}
