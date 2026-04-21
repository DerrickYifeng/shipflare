// Stage 2 — Scanning. Decorative six-step animation running in parallel
// with the real extract API call.
//
// Source selection (URL vs GitHub) changes the label set of the first three
// steps and which API we hit:
//  - URL   → POST /api/onboarding/extract
//  - repo  → POST /api/onboarding/extract-repo (SSE stream — we just wait
//            for type=complete / type=error)

'use client';

import { useEffect, useRef, useState } from 'react';
import { OnbMono } from './_shared/onb-mono';
import { SixStepAnimator } from './_shared/six-step-animator';
import { COPY } from './_copy';
import type { ExtractedProfile } from '@/types/onboarding';

type Source =
  | { kind: 'url'; url: string }
  | { kind: 'github'; repoFullName: string };

interface StageScanningProps {
  source: Source;
  onExtracted: (profile: ExtractedProfile) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}

interface RepoScanComplete {
  type: 'complete';
  // Server publishes the already-shaped ExtractedProfile under `data`.
  // See src/workers/processors/code-scan.ts `publish({ type: 'complete', data })`.
  data: {
    url: string | null;
    name: string;
    description: string;
    keywords: string[];
    valueProp: string;
    ogImage: string | null;
    seoAudit: Record<string, unknown> | null;
  };
}

interface RepoScanError {
  type: 'error';
  error: string;
}

type RepoScanMessage =
  | RepoScanComplete
  | RepoScanError
  | { type: string; [key: string]: unknown };

function displayHost(source: Source): string {
  if (source.kind === 'github') return source.repoFullName;
  try {
    const u = new URL(
      source.url.startsWith('http') ? source.url : `https://${source.url}`,
    );
    return u.host;
  } catch {
    return source.url;
  }
}

async function extractFromUrl(url: string): Promise<ExtractedProfile> {
  const res = await fetch('/api/onboarding/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Extract failed (${res.status})`);
  }
  return (await res.json()) as ExtractedProfile;
}

async function extractFromRepo(
  repoFullName: string,
  signal: AbortSignal,
): Promise<ExtractedProfile> {
  const res = await fetch('/api/onboarding/extract-repo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoFullName }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Repo scan failed (${res.status})`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Repo scan returned no stream');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as RepoScanMessage;
        if (parsed.type === 'error') {
          throw new Error((parsed as RepoScanError).error || 'Repo scan error');
        }
        if (parsed.type === 'complete') {
          const c = parsed as RepoScanComplete;
          // Fall back to the repo URL when the server couldn't extract a
          // homepage (readme/package.json had no `homepage` field).
          return {
            ...c.data,
            url: c.data.url ?? `https://github.com/${repoFullName}`,
          };
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  throw new Error('Repo scan stream ended without a complete event');
}

export function StageScanning({
  source,
  onExtracted,
  onError,
  onCancel,
}: StageScanningProps) {
  const [realCallComplete, setRealCallComplete] = useState(false);
  const [realCallError, setRealCallError] = useState<string | null>(null);
  const extractedRef = useRef<ExtractedProfile | null>(null);
  const steps =
    source.kind === 'github' ? COPY.stage2.stepsGithub : COPY.stage2.stepsUrl;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const profile =
          source.kind === 'url'
            ? await extractFromUrl(source.url)
            : await extractFromRepo(source.repoFullName, controller.signal);
        extractedRef.current = profile;
        setRealCallComplete(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setRealCallError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => controller.abort();
  }, [source]);

  // Surface error to orchestrator after a small delay so user sees the red
  // state before we bounce back to Stage 1.
  useEffect(() => {
    if (!realCallError) return;
    const t = setTimeout(() => onError(realCallError), 900);
    return () => clearTimeout(t);
  }, [realCallError, onError]);

  const handleComplete = () => {
    const profile = extractedRef.current;
    if (profile) onExtracted(profile);
  };

  return (
    <div>
      <OnbMono>{COPY.stage2.kicker}</OnbMono>
      <h2
        style={{
          margin: '12px 0 8px',
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.1,
          letterSpacing: '-0.28px',
          color: 'var(--sf-fg-1)',
        }}
      >
        {COPY.stage2.title}{' '}
        <span
          style={{
            fontFamily: 'var(--sf-font-mono)',
            fontSize: 24,
            fontWeight: 500,
          }}
        >
          {displayHost(source)}
        </span>
      </h2>
      <p
        style={{
          margin: '0 0 24px',
          fontSize: 15,
          lineHeight: 1.47,
          letterSpacing: '-0.224px',
          color: 'var(--sf-fg-2)',
        }}
      >
        {COPY.stage2.sub}
      </p>

      <SixStepAnimator
        steps={steps}
        agentName={COPY.stage2.agentName}
        cancelLabel={COPY.stage2.cancel}
        onCancel={onCancel}
        realCallComplete={realCallComplete}
        realCallError={realCallError}
        onComplete={handleComplete}
      />

      <div
        style={{
          marginTop: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.24)',
          }}
        />
        <OnbMono>{COPY.stage2.footer}</OnbMono>
      </div>
    </div>
  );
}
