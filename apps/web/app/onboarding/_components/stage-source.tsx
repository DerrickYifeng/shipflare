// Stage 1 — Source picker. Three sub-states (choose / github / url) that
// eventually fan into the extract API and advance to stage 'scanning'.
//
// Behavior notes:
//  - URL and GitHub selections advance immediately to Stage 2 ('scanning').
//    That stage owns both the decorative animation AND the real extract
//    network call (per frontend spec §4 Stage 2 implementation note).
//  - "Continue with just this URL" uses the `onManualSubmit` escape hatch —
//    it seeds the draft with an empty profile that Stage 3 lets the user
//    fill in manually.

import { useState, useEffect, type FormEvent } from 'react';
import { authClient } from '@/auth-client';
import { OnbButton } from './_shared/onb-button';
import { OnbInput } from './_shared/onb-input';
import { Field } from './_shared/field';
import { MethodCard } from './_shared/method-card';
import { RepoList } from './_shared/repo-list';
import type { RepoRowData } from './_shared/repo-row';
import { BackLink } from './_shared/back-link';
import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { ArrowRight, GitHub, Globe } from './icons';
import { COPY } from './_copy';
import type { ExtractedProfile } from '@/lib/types/onboarding';

type Method = 'choose' | 'github' | 'url';

interface StageSourceProps {
  /** Seed value when user navigates back. */
  initialUrl?: string;
  initialMethod?: Method;
  initialRepoFullName?: string | null;
  /** Resolve when user confirms the URL — kicks off Stage 2. */
  onScanUrl: (url: string) => void;
  /** Resolve when user picks a repo — kicks off Stage 2 for GitHub. */
  onScanRepo: (repoFullName: string) => void;
  /** "Continue with just this URL" fallback. Seeds draft + advances to review. */
  onManualSubmit: (product: ExtractedProfile) => void;
}

interface GithubReposResponse {
  repos: Array<{
    fullName: string;
    name: string;
    description: string | null;
    homepage: string | null;
    language: string | null;
    stargazersCount: number;
    pushedAt: string;
  }>;
  username?: string;
  error?: string;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return 'last week';
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function StageSource({
  initialUrl = '',
  initialMethod = 'choose',
  initialRepoFullName = null,
  onScanUrl,
  onScanRepo,
  onManualSubmit,
}: StageSourceProps) {
  const [method, setMethod] = useState<Method>(initialMethod);
  const [url, setUrl] = useState(initialUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoRowData[]>([]);
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghConnected, setGhConnected] = useState<'unknown' | 'yes' | 'no'>(
    'unknown',
  );
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<
    string | null
  >(initialRepoFullName);

  const loadRepos = async (): Promise<'connected' | 'not-linked' | 'error'> => {
    setGhLoading(true);
    setGhError(null);
    try {
      const res = await fetch('/api/onboarding/github-repos');
      if (res.status === 404) {
        setGhConnected('no');
        return 'not-linked';
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const body = (await res.json()) as GithubReposResponse;
      setGhConnected('yes');
      setGhUsername(body.username ?? null);
      const rows: RepoRowData[] = body.repos.map((r) => ({
        fullName: r.fullName,
        name: r.name,
        description: r.description,
        homepage: r.homepage,
        language: r.language,
        stargazersCount: r.stargazersCount,
        pushedAt: r.pushedAt,
        updatedLabel: relativeTime(r.pushedAt),
      }));
      setRepos(rows);
      return 'connected';
    } catch (err) {
      setGhError(err instanceof Error ? err.message : 'Failed to load repos');
      return 'error';
    } finally {
      setGhLoading(false);
    }
  };

  const pickMethod = async (next: Method) => {
    setMethod(next);
    // GitHub: short-circuit the "Authorize ShipFlare" intermediate card. If
    // the user is already linked (or signed in via GitHub originally with
    // public_repo scope), loadRepos returns 'connected' and the repo list
    // renders. If they're not linked, jump straight to the GitHub OAuth
    // flow — the user's intent was clear when they picked the GitHub card.
    if (next === 'github' && ghConnected === 'unknown') {
      const result = await loadRepos();
      if (result === 'not-linked') {
        void connectGithub();
      }
    }
  };

  const connectGithub = async () => {
    // Use `linkSocial` (NOT `signIn.social`): the user is already signed in
    // (typically via Google) — they have no GitHub account linked to their
    // session, and `signIn.social` on an authenticated session short-circuits
    // and returns 200 with no redirect URL. `linkSocial` hits Better Auth's
    // `/link-social` endpoint which performs the OAuth dance to ATTACH a new
    // provider to the existing session.
    //
    // `?ghAuthorized=1` lets stage-source resume the github sub-state on
    // return — without it, `method` resets to 'choose' on remount and the
    // user lands back at the method picker instead of seeing their repos.
    setGhError(null);
    try {
      const result = await authClient.linkSocial({
        provider: 'github',
        callbackURL: '/onboarding?ghAuthorized=1',
      });
      if (result.error) {
        setGhError(result.error.message ?? 'GitHub authorization failed.');
        return;
      }
      const url = (result.data as { url?: string } | null)?.url;
      if (url) {
        window.location.assign(url);
        return;
      }
      // Some Better Auth response paths (idToken branch, already-linked)
      // return `{ redirect: false }` without a URL — in our flow that means
      // the account is already linked, so re-trigger the repo fetch.
      void loadRepos();
    } catch (err) {
      setGhError(
        err instanceof Error ? err.message : 'GitHub authorization failed.',
      );
    }
  };

  // Resume the github sub-state after returning from the OAuth callback.
  // We strip the marker from the URL once consumed so a refresh doesn't
  // re-trigger the auto-load.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('ghAuthorized') === '1') {
      params.delete('ghAuthorized');
      const cleaned = params.toString();
      const nextUrl =
        window.location.pathname + (cleaned ? `?${cleaned}` : '');
      window.history.replaceState({}, '', nextUrl);
      setMethod('github');
      void loadRepos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError(COPY.stage1.urlError);
      return;
    }
    // Accept bare domains (e.g. `shipflare.ai`); the scraper's
    // `new URL()` requires a scheme, so default to https://.
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      // Confirm it parses; throws on invalid input.
      new URL(withScheme);
    } catch {
      setUrlError(COPY.stage1.urlError);
      return;
    }
    setUrlError(null);
    onScanUrl(withScheme);
  };

  return (
    <div>
      <StepHeader
        kicker={COPY.stage1.kicker}
        title={COPY.stage1.title}
        sub={COPY.stage1.sub}
      />

      {method === 'choose' && (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 14,
            }}
          >
            <MethodCard
              icon={<GitHub />}
              title={COPY.stage1.methodGithub.title}
              sub={COPY.stage1.methodGithub.sub}
              onClick={() => pickMethod('github')}
            />
            <MethodCard
              icon={<Globe />}
              title={COPY.stage1.methodUrl.title}
              sub={COPY.stage1.methodUrl.sub}
              onClick={() => pickMethod('url')}
            />
          </div>
          <div style={{ marginTop: 24 }}>
            <button
              type="button"
              onClick={() =>
                onManualSubmit({
                  url: '',
                  name: '',
                  description: '',
                  keywords: [],
                  valueProp: '',
                  targetAudience: '',
                  ogImage: null,
                  seoAudit: null,
                })
              }
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: 14,
                color: 'var(--sf-link)',
                letterSpacing: '-0.224px',
              }}
            >
              {COPY.stage1.orManual}
            </button>
          </div>
        </div>
      )}

      {method === 'github' && (
        <div>
          <BackLink
            onClick={() => setMethod('choose')}
            label={COPY.stage1.pickDifferent}
          />
          {/*
            No intermediate "Authorize ShipFlare" card — pickMethod('github')
            either renders the repo list (already linked) or kicks off the
            GitHub OAuth redirect immediately. Two transient states below:
            a redirect placeholder while OAuth is in flight, and an error +
            retry banner if OAuth fails / is dismissed.
          */}
          {ghConnected !== 'yes' && !ghError && (
            <div
              style={{
                padding: '28px 24px',
                background: 'var(--sf-bg-dark-surface)',
                color: 'var(--sf-fg-on-dark-2)',
                borderRadius: 12,
                fontSize: 14,
                letterSpacing: '-0.16px',
              }}
            >
              Redirecting to GitHub…
            </div>
          )}
          {ghConnected === 'yes' && (
            <RepoList
              repos={repos}
              username={ghUsername}
              selectedFullName={selectedRepoFullName}
              onSelect={(r) => setSelectedRepoFullName(r.fullName)}
              searchPlaceholder={COPY.stage1.github.searchPlaceholder}
            />
          )}
          {ghError && (
            <div
              style={{
                marginTop: 12,
                padding: '14px 16px',
                background: 'var(--sf-error-light)',
                color: 'var(--sf-error-ink)',
                borderRadius: 10,
                fontSize: 13,
                letterSpacing: '-0.16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <span>{ghError}</span>
              <button
                type="button"
                onClick={() => {
                  setGhError(null);
                  void connectGithub();
                }}
                disabled={ghLoading}
                style={{
                  background: 'transparent',
                  border: '1px solid currentColor',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'inherit',
                  cursor: ghLoading ? 'default' : 'pointer',
                  opacity: ghLoading ? 0.6 : 1,
                }}
              >
                Try again
              </button>
            </div>
          )}
          <ActionBar
            marginTop={24}
            back={
              <OnbButton
                variant="ghost"
                size="lg"
                onClick={() => setMethod('choose')}
              >
                Back
              </OnbButton>
            }
            primary={
              <OnbButton
                size="lg"
                variant="primary"
                disabled={!selectedRepoFullName}
                onClick={() => {
                  if (selectedRepoFullName) onScanRepo(selectedRepoFullName);
                }}
              >
                {COPY.stage1.scanRepo}
                <ArrowRight size={14} />
              </OnbButton>
            }
          />
        </div>
      )}

      {method === 'url' && (
        <form onSubmit={submitUrl}>
          <BackLink
            onClick={() => setMethod('choose')}
            label={COPY.stage1.pickDifferent}
          />
          <Field
            label={COPY.stage1.urlLabel}
            hint={COPY.stage1.urlHint}
            error={urlError ?? undefined}
          >
            <OnbInput
              autoFocus
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlError) setUrlError(null);
              }}
              placeholder={COPY.stage1.urlPlaceholder}
              invalid={!!urlError}
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              autoCapitalize="off"
            />
          </Field>
          <ActionBar
            marginTop={24}
            back={
              <OnbButton
                variant="ghost"
                size="lg"
                onClick={() => setMethod('choose')}
              >
                Back
              </OnbButton>
            }
            primary={
              <OnbButton size="lg" variant="primary" type="submit">
                {COPY.stage1.scanUrl}
                <ArrowRight size={14} />
              </OnbButton>
            }
          />
          {urlError && url.trim() && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() =>
                  onManualSubmit({
                    url: url.trim(),
                    name: '',
                    description: '',
                    keywords: [],
                    valueProp: '',
                    targetAudience: '',
                    ogImage: null,
                    seoAudit: null,
                  })
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'var(--sf-link)',
                  letterSpacing: '-0.16px',
                }}
              >
                {COPY.stage1.fallbackLink}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
