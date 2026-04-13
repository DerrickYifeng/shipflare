'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { DiscoveryCard } from './discovery-card';
import { ThoughtStream } from './thought-stream';
import { signInWithGitHub } from '@/app/actions/auth';
import type { LegacyScanResult, DiscoveredCommunity } from '@/types/discovery';
import { toLegacyDiscoveryResult } from '@/types/discovery';

interface ScanResponse {
  product: {
    name: string;
    description: string;
    url: string;
  };
  communities?: DiscoveredCommunity[];
  results: LegacyScanResult[];
}

interface LandingPageProps {
  isAuthenticated: boolean;
}

const VISIBLE_CARDS = 3;
const SESSION_KEY = 'shipflare_scan_url';
const SESSION_DATA_KEY = 'shipflare_scan_data';

export function LandingPage({ isAuthenticated }: LandingPageProps) {
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [data, setData] = useState<ScanResponse | null>(null);

  // After OAuth redirect, restore cached scan results and persist to DB
  useEffect(() => {
    if (isAuthenticated) {
      const storedData = sessionStorage.getItem(SESSION_DATA_KEY);
      const storedUrl = sessionStorage.getItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_DATA_KEY);

      if (storedData) {
        try {
          const parsed = JSON.parse(storedData) as ScanResponse;
          setData(parsed);
          if (storedUrl) setUrl(storedUrl);

          // Persist to database so dashboard also shows these threads
          if (parsed.results.length > 0) {
            fetch('/api/discovery/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ results: parsed.results }),
            }).catch(() => { /* best-effort */ });
          }
        } catch {
          // Corrupted data, ignore
        }
      }
    }
  }, [isAuthenticated]);

  function normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return trimmed;
  }

  function startScan(rawUrl: string) {
    const normalized = normalizeUrl(rawUrl);
    setUrl(normalized);
    setError('');
    setData(null);
    setScanning(true);
    setScanUrl(normalized);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    startScan(url);
  }

  function handleComplete(result: ScanResponse) {
    setData(result);
    setScanning(false);
    setScanUrl(null);
  }

  function handleError(message: string) {
    setError(message);
    setScanning(false);
    setScanUrl(null);
  }

  function handleSignIn() {
    if (url) {
      sessionStorage.setItem(SESSION_KEY, url);
    }
    if (data) {
      sessionStorage.setItem(SESSION_DATA_KEY, JSON.stringify(data));
    }
  }

  const results = data?.results ?? [];
  const mapped = results.map(toLegacyDiscoveryResult);
  const visibleResults = isAuthenticated ? mapped : mapped.slice(0, VISIBLE_CARDS);
  const blurredResults = isAuthenticated ? [] : mapped.slice(VISIBLE_CARDS);
  const hasBlurred = blurredResults.length > 0;

  return (
    <main className="min-h-screen bg-sf-bg-primary flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-5 max-w-[960px] mx-auto w-full">
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2C12 2 6.5 8 6.5 13a5.5 5.5 0 0 0 11 0C17.5 8 12 2 12 2z"
              fill="var(--color-sf-accent)"
            />
            <path
              d="M12 10c0 0-2.5 3-2.5 5.5a2.5 2.5 0 0 0 5 0C14.5 13 12 10 12 10z"
              fill="var(--color-sf-bg-primary)"
            />
          </svg>
          <span className="text-[15px] font-semibold text-sf-text-primary tracking-tight">
            ShipFlare
          </span>
        </div>
        <nav className="flex items-center gap-5">
          <span className="text-[13px] text-sf-text-tertiary hidden sm:inline">
            AI marketing autopilot for indie devs
          </span>
          {isAuthenticated ? (
            <a
              href="/dashboard"
              className="text-[13px] font-medium text-sf-text-secondary hover:text-sf-text-primary transition-colors duration-150"
            >
              Dashboard
            </a>
          ) : (
            <form action={signInWithGitHub}>
              <button
                type="submit"
                className="text-[13px] font-medium text-sf-text-secondary hover:text-sf-text-primary transition-colors duration-150 cursor-pointer"
              >
                Sign in
              </button>
            </form>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section className={`max-w-[960px] mx-auto px-8 pb-8 w-full ${!data && !scanning ? 'flex-1 flex flex-col items-center justify-center' : 'pt-20 flex flex-col items-center'}`}>
        <h1 className="text-[clamp(32px,5vw,44px)] font-bold text-sf-text-primary tracking-tight leading-tight text-center">
          Find where your users are talking
        </h1>
        <p className="mt-3 text-[15px] text-sf-text-secondary leading-relaxed text-center">
          Paste your product URL. We&apos;ll find the conversations.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-8 w-full max-w-[520px] flex items-center rounded-[var(--radius-sf-lg)] border border-sf-border hover:border-sf-text-tertiary focus-within:border-sf-text-tertiary focus-within:shadow-[0_0_0_3px_rgba(0,0,0,0.04)] transition-all duration-150 bg-sf-bg-primary outline-none focus-visible:outline-none"
        >
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yourproduct.com"
            className="
              flex-1 min-h-[48px] px-4 py-2
              text-[15px] text-sf-text-primary
              bg-transparent placeholder:text-sf-text-tertiary
              outline-none border-none focus:outline-none focus-visible:outline-none
            "
          />
          <button
            type="submit"
            disabled={scanning || !url.trim()}
            className="
              shrink-0 min-h-[36px] px-5 mr-1.5
              bg-sf-accent text-white font-medium text-[14px]
              rounded-[var(--radius-sf-md)]
              hover:bg-sf-accent-hover
              transition-colors duration-150
              disabled:opacity-50 disabled:pointer-events-none
              cursor-pointer
            "
          >
            {scanning ? 'Scanning...' : 'Scan'}
          </button>
        </form>

        {error && (
          <p className="mt-3 text-[13px] text-sf-error text-center">{error}</p>
        )}
      </section>

      {/* Thought Stream (replaces skeleton loaders) */}
      {scanning && scanUrl && (
        <section className="max-w-[640px] mx-auto px-6 pb-8">
          <ThoughtStream
            url={scanUrl}
            onComplete={handleComplete}
            onError={handleError}
          />
        </section>
      )}

      {/* Results */}
      {data && !scanning && (
        <section className="max-w-[640px] mx-auto px-6 pb-16 animate-sf-fade-in">
          {/* Product context */}
          {data.product.name && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-[13px] text-sf-text-tertiary">
                Results for
              </span>
              <span className="text-[13px] font-medium text-sf-text-primary">
                {data.product.name}
              </span>
            </div>
          )}

          {/* Discovered communities */}
          {data.communities && data.communities.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {data.communities.map((c) => (
                <CommunityPill key={c.name} community={c} />
              ))}
            </div>
          )}

          {/* Results list */}
          {mapped.length > 0 && (
            <div className="relative">
              <div className="border border-sf-border rounded-[var(--radius-sf-lg)] overflow-hidden">
                {visibleResults.map((result) => (
                  <DiscoveryCard
                    key={result.externalId}
                    source={result.source}
                    title={result.title}
                    url={result.url}
                    community={result.community}
                    relevanceScore={result.score}
                    metadata={result.metadata}
                    reason={result.reason}
                    intent={result.intent}
                    postedAt={result.postedAt}
                  />
                ))}

                {/* Blurred cards */}
                {hasBlurred && (
                  <div className="relative">
                    <div className="blur-[6px] pointer-events-none select-none" aria-hidden="true">
                      {blurredResults.slice(0, 5).map((result) => (
                        <DiscoveryCard
                          key={result.externalId}
                          source={result.source}
                          title={result.title}
                          url={result.url}
                          community={result.community}
                          relevanceScore={result.score}
                          metadata={result.metadata}
                          reason={result.reason}
                          postedAt={result.postedAt}
                        />
                      ))}
                    </div>

                    {/* Gradient overlay + CTA */}
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/70 to-white flex flex-col items-center justify-end pb-8">
                      <p className="text-[15px] font-medium text-sf-text-primary mb-4">
                        Sign in to unlock all {results.length} results
                      </p>
                      <form action={async () => { handleSignIn(); await signInWithGitHub(); }}>
                        <button
                          type="submit"
                          className="
                            flex items-center justify-center gap-2.5
                            min-h-[44px] px-5 py-2.5
                            bg-sf-text-primary text-white
                            rounded-[var(--radius-sf-md)]
                            font-medium text-[15px]
                            hover:bg-sf-text-secondary
                            transition-colors duration-150
                            cursor-pointer
                          "
                        >
                          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z" clipRule="evenodd" />
                          </svg>
                          Sign in with GitHub
                        </button>
                      </form>
                    </div>
                  </div>
                )}
              </div>

              {/* Authenticated: show Go to Dashboard */}
              {isAuthenticated && mapped.length > 0 && (
                <div className="mt-6 text-center">
                  <a
                    href="/dashboard"
                    className="
                      inline-flex items-center gap-2
                      min-h-[44px] px-6 py-2
                      bg-sf-accent text-white font-medium text-[15px]
                      rounded-[var(--radius-sf-md)]
                      hover:bg-sf-accent-hover
                      transition-colors duration-150
                    "
                  >
                    Go to Dashboard
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
                    </svg>
                  </a>
                </div>
              )}
            </div>
          )}

          {/* No results */}
          {mapped.length === 0 && (
            <div className="text-center py-12">
              <p className="text-[15px] text-sf-text-secondary">
                No relevant conversations found for this URL.
              </p>
              <p className="mt-1 text-[13px] text-sf-text-tertiary">
                Try a different URL or check that the page has meta tags.
              </p>
            </div>
          )}
        </section>
      )}
      {/* Footer — subtle context, not marketing */}
      {!scanning && !data && (
        <footer className="max-w-[960px] mx-auto px-8 pb-8 w-full">
          <div className="flex items-center justify-center gap-6 text-[11px] text-sf-text-tertiary">
            <span>Scans Reddit, HN, Twitter &amp; more</span>
            <span className="w-px h-3 bg-sf-border" aria-hidden="true" />
            <span>No sign-up required to try</span>
            <span className="w-px h-3 bg-sf-border" aria-hidden="true" />
            <span>Results in ~10 seconds</span>
          </div>
        </footer>
      )}
    </main>
  );
}

function CommunityPill({ community }: { community: DiscoveredCommunity }) {
  const fit = Math.round(community.audienceFit * 100);
  const subs = community.subscribers
    ? community.subscribers >= 1_000_000
      ? `${(community.subscribers / 1_000_000).toFixed(1)}M`
      : community.subscribers >= 1_000
        ? `${Math.round(community.subscribers / 1_000)}k`
        : String(community.subscribers)
    : null;

  return (
    <div
      className="group relative flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-sf-border bg-sf-bg-secondary text-[12px] text-sf-text-secondary"
      title={community.reason}
    >
      <span className="font-medium text-sf-text-primary">{community.name}</span>
      {subs && (
        <span className="text-sf-text-tertiary">{subs}</span>
      )}
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{
          backgroundColor: fit >= 70
            ? 'var(--color-sf-success)'
            : fit >= 50
              ? 'var(--color-sf-accent)'
              : 'var(--color-sf-text-tertiary)',
        }}
      />
      {/* Tooltip on hover */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-[var(--radius-sf-md)] bg-sf-text-primary text-white text-[11px] leading-snug max-w-[240px] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 z-10 whitespace-normal">
        {community.reason}
      </div>
    </div>
  );
}
