'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { DiscoveryCard } from './discovery-card';
import { ThoughtStream } from './thought-stream';
import type { LegacyScanResult, DiscoveredCommunity } from '@/types/discovery';
import { toLegacyDiscoveryResult } from '@/types/discovery';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';
import { SignInModal } from '@/components/auth/sign-in-modal';

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
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInContext, setSignInContext] = useState<'nav' | 'unlock'>('nav');

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
          // Post-OAuth restore of cached scan results from sessionStorage —
          // a one-shot sync that fires once per redirect. Proper idiom is
          // `useSyncExternalStore`, but that refactor is out of scope here.
          // eslint-disable-next-line react-hooks/set-state-in-effect
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
    <main className="min-h-screen flex flex-col">
      {/* ─── Dark hero section ─── */}
      <div className="bg-sf-bg-dark text-sf-text-on-dark">
        {/* Glass nav */}
        <header className="flex items-center justify-between px-8 py-4 max-w-[980px] mx-auto w-full">
          <div className="flex items-center gap-2">
            <ShipFlareLogo size={20} />
            <span className="text-[14px] font-medium text-white/80 tracking-[-0.224px]">
              ShipFlare
            </span>
          </div>
          <nav className="flex items-center gap-5">
            <span className="text-[12px] text-white/48 hidden sm:inline tracking-[-0.12px]">
              AI marketing autopilot for indie devs
            </span>
            {isAuthenticated ? (
              <a
                href="/today"
                className="text-[14px] text-sf-link-dark hover:underline transition-colors duration-200 inline-flex items-center min-h-[44px] px-2 tracking-[-0.224px]"
              >
                Today
              </a>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setSignInContext('nav');
                  setSignInOpen(true);
                }}
                className="text-[14px] text-sf-link-dark hover:underline transition-colors duration-200 cursor-pointer inline-flex items-center min-h-[44px] px-2 tracking-[-0.224px]"
              >
                Sign in
              </button>
            )}
          </nav>
        </header>

        {/* Hero content */}
        <section className={`max-w-[980px] mx-auto px-8 pb-16 w-full ${!data && !scanning ? 'flex-1 flex flex-col items-center justify-center min-h-[60vh]' : 'pt-20 flex flex-col items-center'}`}>
          <h1 className="text-[clamp(40px,6vw,56px)] font-semibold tracking-[-0.28px] leading-[1.07] text-center text-white">
            Find where your users<br className="hidden sm:inline" /> are talking
          </h1>
          <p className="mt-4 text-[21px] font-normal text-white/80 leading-[1.19] tracking-[0.231px] text-center">
            Paste your product URL. We&apos;ll find the conversations.
          </p>

          <form
            onSubmit={handleSubmit}
            className="mt-10 w-full max-w-[560px] flex items-center rounded-[var(--radius-sf-lg)] bg-white/[0.12] backdrop-blur-md hover:bg-white/[0.16] focus-within:bg-white/[0.18] focus-within:shadow-[0_0_0_3px_rgba(41,151,255,0.3)] transition-all duration-200 outline-none focus-visible:outline-none"
          >
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="yourproduct.com"
              aria-label="Product URL"
              name="product-url"
              autoComplete="url"
              inputMode="url"
              className="
                flex-1 min-h-[52px] px-5 py-2
                text-[17px] tracking-[-0.374px] text-white
                bg-transparent placeholder:text-white/40
                outline-none border-none focus:outline-none focus-visible:outline-none
              "
            />
            <button
              type="submit"
              disabled={scanning || !url.trim()}
              className="
                shrink-0 min-h-[44px] px-6 mr-1
                bg-sf-accent text-white font-normal text-[17px] tracking-[-0.374px]
                rounded-[var(--radius-sf-md)]
                hover:bg-sf-accent-hover
                transition-all duration-200
                disabled:opacity-40 disabled:pointer-events-none
                cursor-pointer
              "
            >
              {scanning ? 'Scanning...' : 'Scan'}
            </button>
          </form>

          {error && (
            <p className="mt-3 text-[14px] text-sf-error text-center tracking-[-0.224px]">{error}</p>
          )}
        </section>
      </div>

      {/* ─── Light section: Thought Stream ─── */}
      {scanning && scanUrl && (
        <section className="bg-sf-bg-primary">
          <div className="max-w-[640px] mx-auto px-6 py-10">
            <ThoughtStream
              url={scanUrl}
              onComplete={handleComplete}
              onError={handleError}
            />
          </div>
        </section>
      )}

      {/* ─── Light section: Results ─── */}
      {data && !scanning && (
        <section className="bg-sf-bg-primary animate-sf-fade-in">
          <div className="max-w-[640px] mx-auto px-6 py-10 pb-16">
            {/* Product context */}
            {data.product.name && (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-[14px] text-sf-text-tertiary tracking-[-0.224px]">
                  Results for
                </span>
                <span className="text-[14px] font-semibold text-sf-text-primary tracking-[-0.224px]">
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
                <div className="bg-sf-bg-secondary rounded-[var(--radius-sf-lg)] shadow-[var(--shadow-sf-card)] overflow-hidden">
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
                            intent={result.intent}
                            postedAt={result.postedAt}
                          />
                        ))}
                      </div>

                      {/* Gradient overlay + CTA */}
                      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#f5f5f7]/70 to-[#f5f5f7] flex flex-col items-center justify-end pb-8">
                        <p className="text-[17px] font-semibold text-sf-text-primary mb-4 tracking-[-0.374px]">
                          Sign in to unlock all {results.length} results
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setSignInContext('unlock');
                            setSignInOpen(true);
                          }}
                          className="
                            flex items-center justify-center gap-2.5
                            min-h-[44px] px-5 py-2.5
                            bg-sf-bg-dark-surface text-white
                            rounded-[var(--radius-sf-md)]
                            font-normal text-[17px] tracking-[-0.374px]
                            hover:bg-[#2c2c2e]
                            transition-all duration-200
                            cursor-pointer
                          "
                        >
                          Sign in to continue
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Authenticated: show Go to Today */}
                {isAuthenticated && mapped.length > 0 && (
                  <div className="mt-8 text-center">
                    <a
                      href="/today"
                      className="
                        inline-flex items-center gap-2
                        min-h-[44px] px-6 py-2
                        bg-sf-accent text-white font-normal text-[17px] tracking-[-0.374px]
                        rounded-[var(--radius-sf-md)]
                        hover:bg-sf-accent-hover
                        transition-all duration-200
                      "
                    >
                      Go to Today
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
              <div className="text-center py-16">
                <p className="text-[17px] text-sf-text-secondary tracking-[-0.374px]">
                  No relevant conversations found for this URL.
                </p>
                <p className="mt-2 text-[14px] text-sf-text-tertiary tracking-[-0.224px]">
                  Try a different URL or check that the page has meta tags.
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Footer — subtle context */}
      {!scanning && !data && (
        <footer className="bg-sf-bg-dark text-white/48 pb-10">
          <div className="max-w-[980px] mx-auto px-8 w-full">
            <div className="flex items-center justify-center gap-6 text-[12px] tracking-[-0.12px]">
              <span>Scans Reddit, HN, X &amp; more</span>
              <span className="w-px h-3 bg-white/20" aria-hidden="true" />
              <span>No sign-up required to try</span>
              <span className="w-px h-3 bg-white/20" aria-hidden="true" />
              <span>Results in ~10 seconds</span>
            </div>
          </div>
        </footer>
      )}
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        onBeforeSignIn={signInContext === 'unlock' ? handleSignIn : undefined}
      />
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
      className="group relative flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sf-pill)] bg-sf-bg-secondary shadow-[var(--shadow-sf-card)] text-[12px] tracking-[-0.12px] text-sf-text-secondary"
      title={community.reason}
    >
      <span className="font-semibold text-sf-text-primary">{community.name}</span>
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
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-[var(--radius-sf-md)] bg-sf-bg-dark-surface text-white text-[12px] leading-snug tracking-[-0.12px] max-w-[240px] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-200 z-10 whitespace-normal">
        {community.reason}
      </div>
    </div>
  );
}
