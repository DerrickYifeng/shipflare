'use client';

// OnboardingFlow — top-level state machine + responsive shell.
// Each stage is a standalone component; this file owns the state machine,
// Redis draft sync, and routing between stages.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractedProfile } from '@/types/onboarding';
import type { StrategicPath, TacticalPlan } from '@/agents/schemas';
import { ProgressRail } from './progress-rail';
import { MobileHeader } from './mobile-header';
import { TopChevron } from './top-chevron';
import { WorkArea } from './work-area';
import { StageSource } from './stage-source';
import { StageScanning } from './stage-scanning';
import { StageReview } from './stage-review';
import { inferCategory } from './_infer-category';
import { StageConnect } from './stage-connect';
import { StageState } from './stage-state';
import { StagePlanBuilding } from './stage-plan-building';
import { StagePlan } from './stage-plan';

export type Stage =
  | 'source'
  | 'scanning'
  | 'review'
  | 'connect'
  | 'state'
  | 'plan-building'
  | 'plan';

export type ProductState = 'mvp' | 'launching' | 'launched';
export type LaunchChannel = 'producthunt' | 'showhn' | 'both' | 'other';
export type UsersBucket = '<100' | '100-1k' | '1k-10k' | '10k+';
export type ProductCategory =
  | 'dev_tool'
  | 'saas'
  | 'consumer'
  | 'creator_tool'
  | 'agency'
  | 'ai_app'
  | 'other';

export interface DraftState {
  product: ExtractedProfile | null;
  audience: string;
  voice: string;
  category: ProductCategory;
  reviewed: boolean;
  productState: ProductState | null;
  /** Future launch date (YYYY-MM-DD) — `state='launching'` + optional for `mvp`. */
  launchDate: string | null;
  /** Past launch date (YYYY-MM-DD) — `state='launched'` only. */
  launchedAt: string | null;
  launchChannel: LaunchChannel | null;
  usersBucket: UsersBucket | null;
  path: StrategicPath | null;
  plan: TacticalPlan | null;
  /** Last known source kind. Drives chip in Stage 3 + scanning variant. */
  sourceKind: 'github' | 'url' | 'manual' | 'url-only' | null;
  /** URL typed in Stage 1. Preserved across back-navigation. */
  sourceUrl: string;
  sourceRepoFullName: string | null;
}

const INITIAL_DRAFT: DraftState = {
  product: null,
  audience: '',
  voice: '',
  category: 'other',
  reviewed: false,
  productState: null,
  launchDate: null,
  launchedAt: null,
  launchChannel: null,
  usersBucket: null,
  path: null,
  plan: null,
  sourceKind: null,
  sourceUrl: '',
  sourceRepoFullName: null,
};

const DESKTOP_BREAKPOINT = 880;

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`);
    const sync = () => setIsDesktop(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);
  return isDesktop;
}

function stepIndexFor(stage: Stage): 0 | 1 | 2 | 3 {
  if (stage === 'source' || stage === 'scanning' || stage === 'review') {
    return 0;
  }
  if (stage === 'connect') return 1;
  if (stage === 'state') return 2;
  return 3;
}

/** Shape of the persisted Redis draft (subset of OnboardingDraft from
 * `src/lib/onboarding-draft.ts` — frontend is tolerant to missing keys). */
interface PersistedDraft {
  source?: 'url' | 'github' | 'manual';
  url?: string | null;
  githubRepo?: string | null;
  name?: string;
  description?: string;
  valueProp?: string | null;
  keywords?: string[];
  targetAudience?: string | null;
  category?: ProductCategory;
  channels?: Array<'x' | 'reddit' | 'email'>;
  state?: ProductState;
  launchDate?: string | null;
  launchedAt?: string | null;
  /** Frontend-only fields (backend schema strips these until plumbed). */
  launchChannel?: LaunchChannel | null;
  usersBucket?: UsersBucket | null;
  previewPath?: StrategicPath | null;
  previewPlan?: TacticalPlan | null;
}

// Serialize draft PUTs. The server's read-modify-write is not atomic
// (see `src/lib/onboarding-draft.ts` putDraft — it reads, merges in
// memory, writes), so two concurrent PUTs can reorder and the later
// patch can lose. Chain every call off a single queue ref so the
// server sees writes in fire order. Fire-and-forget is preserved —
// callers don't await this, but a later PUT won't leapfrog an earlier
// one.
let draftQueue: Promise<unknown> = Promise.resolve();

async function persistDraft(
  patch: Partial<PersistedDraft>,
): Promise<void> {
  // Chain this PUT off the tail of the queue so the server processes
  // concurrent `mirrorToRedis` calls in fire order rather than
  // racing them through the non-atomic read-modify-write in
  // `src/lib/onboarding-draft.ts`. The tail promise is settled
  // (always resolves) so one rejected PUT doesn't poison the queue
  // for subsequent writes.
  const next = draftQueue.then(async () => {
    try {
      await fetch('/api/onboarding/draft', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch {
      // Best-effort — the draft is a UX nicety, not correctness-
      // critical. Swallow so the queue stays unbroken.
    }
  });
  draftQueue = next;
  await next;
}

async function hydrateDraft(): Promise<PersistedDraft | null> {
  try {
    const res = await fetch('/api/onboarding/draft');
    if (!res.ok) return null;
    const body = (await res.json()) as { draft: PersistedDraft | null };
    return body.draft ?? null;
  } catch {
    return null;
  }
}

function applyPersistedToDraft(
  persisted: PersistedDraft,
  existing: DraftState,
): DraftState {
  const sourceKind =
    persisted.source === 'github'
      ? 'github'
      : persisted.source === 'url'
        ? 'url'
        : persisted.source === 'manual'
          ? 'manual'
          : existing.sourceKind;

  const product: ExtractedProfile | null =
    persisted.name || persisted.description
      ? {
          url: persisted.url ?? '',
          name: persisted.name ?? '',
          description: persisted.description ?? '',
          keywords: persisted.keywords ?? [],
          valueProp: persisted.valueProp ?? '',
          ogImage: null,
          seoAudit: null,
        }
      : existing.product;

  return {
    ...existing,
    product,
    audience: persisted.targetAudience ?? existing.audience,
    category: persisted.category ?? existing.category,
    productState: persisted.state ?? existing.productState,
    launchDate: persisted.launchDate ?? existing.launchDate,
    launchedAt: persisted.launchedAt ?? existing.launchedAt,
    launchChannel: persisted.launchChannel ?? existing.launchChannel,
    usersBucket: persisted.usersBucket ?? existing.usersBucket,
    path: persisted.previewPath ?? existing.path,
    plan: persisted.previewPlan ?? existing.plan,
    sourceKind,
    sourceUrl: persisted.url ?? existing.sourceUrl,
    sourceRepoFullName:
      persisted.githubRepo ?? existing.sourceRepoFullName,
  };
}

function initialStageFromDraft(d: DraftState): Stage {
  if (d.plan && d.path) return 'plan';
  if (d.productState) return 'state';
  if (d.product && d.product.name && d.reviewed) return 'connect';
  if (d.product && d.product.name) return 'review';
  return 'source';
}

interface OnboardingFlowProps {
  initialStage?: Stage;
}

export function OnboardingFlow({ initialStage }: OnboardingFlowProps = {}) {
  const [stage, setStage] = useState<Stage>(initialStage ?? 'source');
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const [connectedChannels, setConnectedChannels] = useState<
    Array<'x' | 'reddit' | 'email'>
  >([]);
  const [hydrated, setHydrated] = useState(false);
  const isDesktop = useIsDesktop();

  // Hydrate from Redis draft on mount. If the user has persisted state,
  // resume at the stage their progress implies.
  useEffect(() => {
    (async () => {
      const persisted = await hydrateDraft();
      if (persisted) {
        setDraft((prev) => {
          const next = applyPersistedToDraft(persisted, prev);
          if (!initialStage) {
            // Only auto-resume when caller didn't force a stage.
            const implied = initialStageFromDraft(next);
            if (implied !== 'source') setStage(implied);
          }
          return next;
        });
      }
      setHydrated(true);
    })();
  }, [initialStage]);

  // Keep connected-channels in sync once per mount + on window focus.
  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch('/api/channels');
        if (!res.ok) return;
        const body = (await res.json()) as {
          channels: Array<{ platform: string }>;
        };
        const platforms = body.channels
          .map((c) => c.platform)
          .filter((p): p is 'x' | 'reddit' | 'email' =>
            p === 'x' || p === 'reddit' || p === 'email',
          );
        setConnectedChannels(Array.from(new Set(platforms)));
      } catch {
        /* ignore */
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const step = stepIndexFor(stage);
  const productName = draft.product?.name || null;

  const updateDraft = useCallback(
    (patch: Partial<DraftState>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  // Mirror important subsets to Redis draft on every stage change. Also
  // debounced text field autosaves go through this.
  const mirrorToRedis = useCallback(
    (d: DraftState) => {
      const persisted: Partial<PersistedDraft> = {
        source: d.sourceKind === 'manual' || d.sourceKind === 'url-only'
          ? 'manual'
          : d.sourceKind ?? undefined,
        url: d.product?.url ?? d.sourceUrl ?? null,
        githubRepo: d.sourceRepoFullName,
        name: d.product?.name ?? '',
        description: d.product?.description ?? '',
        valueProp: d.product?.valueProp ?? null,
        keywords: d.product?.keywords ?? [],
        targetAudience: d.audience || null,
        category: d.category,
        state: d.productState ?? undefined,
        launchDate: d.launchDate ?? null,
        launchedAt: d.launchedAt ?? null,
        launchChannel: d.launchChannel,
        usersBucket: d.usersBucket,
        previewPath: d.path,
        previewPlan: d.plan,
      };
      void persistDraft(persisted);
    },
    [],
  );

  const backFor = (current: Stage): (() => void) | null => {
    switch (current) {
      case 'source':
        return null;
      case 'scanning':
        return () => setStage('source');
      case 'review':
        return () => setStage('source');
      case 'connect':
        return () => setStage('review');
      case 'state':
        return () => setStage('connect');
      case 'plan-building':
        return () => setStage('state');
      case 'plan':
        return () => setStage('state');
    }
  };

  const onBack = backFor(stage);
  const chevronLabel =
    stage === 'scanning' || stage === 'plan-building' ? 'Cancel' : 'Back';

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--sf-bg-primary)',
        overflow: 'hidden',
      }}
    >
      {isDesktop && <ProgressRail step={step} productName={productName} />}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {!isDesktop && <MobileHeader step={step} onBack={onBack} />}
        {isDesktop && onBack && (
          <TopChevron onClick={onBack} label={chevronLabel} />
        )}
        <WorkArea
          maxWidth={isDesktop ? 600 : 340}
          animationKey={stage}
        >
          {hydrated && (
            <StageRouter
              stage={stage}
              draft={draft}
              connectedChannels={connectedChannels}
              setStage={setStage}
              updateDraft={updateDraft}
              mirrorToRedis={mirrorToRedis}
            />
          )}
        </WorkArea>
      </div>
    </div>
  );
}

interface StageRouterProps {
  stage: Stage;
  draft: DraftState;
  connectedChannels: Array<'x' | 'reddit' | 'email'>;
  setStage: (s: Stage) => void;
  updateDraft: (patch: Partial<DraftState>) => void;
  mirrorToRedis: (d: DraftState) => void;
}

function StageRouter({
  stage,
  draft,
  connectedChannels,
  setStage,
  updateDraft,
  mirrorToRedis,
}: StageRouterProps) {
  const draftRef = useRef(draft);
  draftRef.current = draft;

  switch (stage) {
    case 'source':
      return (
        <StageSource
          initialUrl={draft.sourceUrl}
          initialMethod={
            draft.sourceKind === 'github'
              ? 'github'
              : draft.sourceKind === 'url' || draft.sourceKind === 'url-only'
                ? 'url'
                : 'choose'
          }
          initialRepoFullName={draft.sourceRepoFullName}
          onScanUrl={(url) => {
            const next = {
              ...draftRef.current,
              sourceKind: 'url' as const,
              sourceUrl: url,
              sourceRepoFullName: null,
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('scanning');
          }}
          onScanRepo={(repoFullName) => {
            const next = {
              ...draftRef.current,
              sourceKind: 'github' as const,
              sourceRepoFullName: repoFullName,
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('scanning');
          }}
          onManualSubmit={(product) => {
            const next = {
              ...draftRef.current,
              product,
              sourceKind: product.url ? ('url-only' as const) : ('manual' as const),
              sourceUrl: product.url ?? '',
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('review');
          }}
        />
      );

    case 'scanning': {
      const source =
        draft.sourceKind === 'github' && draft.sourceRepoFullName
          ? ({
              kind: 'github',
              repoFullName: draft.sourceRepoFullName,
            } as const)
          : ({ kind: 'url', url: draft.sourceUrl } as const);
      return (
        <StageScanning
          source={source}
          onExtracted={(profile) => {
            const next: DraftState = {
              ...draftRef.current,
              product: profile,
              audience: draftRef.current.audience,
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('review');
          }}
          onError={() => {
            setStage('source');
          }}
          onCancel={() => setStage('source')}
        />
      );
    }

    case 'review': {
      // Infer category from extracted signals on first entry so the
      // Stage-3 picker starts on the best-fit option rather than
      // "Something else". User can always override. If the draft already
      // had a non-default category (hydrated from Redis), keep it.
      const initialCategory: ProductCategory =
        draft.category !== 'other'
          ? draft.category
          : inferCategory({
              keywords: draft.product?.keywords ?? [],
              description: draft.product?.description ?? '',
              name: draft.product?.name ?? '',
            });
      return (
        <StageReview
          initialValue={{
            name: draft.product?.name ?? '',
            description: draft.product?.description ?? '',
            audience: draft.audience,
            voice: draft.voice || 'Technical, calm, spec-like',
            keywords: draft.product?.keywords ?? [],
            category: initialCategory,
          }}
          sourceKind={draft.sourceKind ?? 'manual'}
          sourceLabel={sourceLabelFor(draft)}
          onBack={() => setStage('source')}
          onAutoSave={(v) => {
            const next: DraftState = {
              ...draftRef.current,
              product: draftRef.current.product
                ? {
                    ...draftRef.current.product,
                    name: v.name,
                    description: v.description,
                    keywords: v.keywords,
                  }
                : {
                    url: draftRef.current.sourceUrl,
                    name: v.name,
                    description: v.description,
                    keywords: v.keywords,
                    valueProp: '',
                    ogImage: null,
                    seoAudit: null,
                  },
              audience: v.audience,
              voice: v.voice,
              category: v.category,
            };
            mirrorToRedis(next);
          }}
          onContinue={(v) => {
            const next: DraftState = {
              ...draftRef.current,
              product: {
                url: draftRef.current.sourceUrl,
                valueProp: '',
                ogImage: null,
                seoAudit: null,
                ...draftRef.current.product,
                name: v.name,
                description: v.description,
                keywords: v.keywords,
              },
              audience: v.audience,
              voice: v.voice,
              category: v.category,
              reviewed: true,
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('connect');
          }}
        />
      );
    }

    case 'connect':
      return (
        <StageConnect
          onBack={() => setStage('review')}
          onContinue={() => setStage('state')}
        />
      );

    case 'state':
      return (
        <StageState
          productState={draft.productState}
          launchDate={draft.launchDate}
          launchedAt={draft.launchedAt}
          launchChannel={draft.launchChannel}
          usersBucket={draft.usersBucket}
          onBack={() => setStage('connect')}
          onChange={(patch) => {
            updateDraft(patch);
            mirrorToRedis({ ...draftRef.current, ...patch });
          }}
          onGeneratePlan={() => setStage('plan-building')}
        />
      );

    case 'plan-building':
      return (
        <StagePlanBuilding
          draft={draft}
          connectedChannels={connectedChannels}
          onGenerated={({ path, plan }) => {
            const next: DraftState = {
              ...draftRef.current,
              path,
              plan,
            };
            updateDraft(next);
            mirrorToRedis(next);
            setStage('plan');
          }}
          onCancel={() => setStage('state')}
          onFallback={() => setStage('state')}
        />
      );

    case 'plan': {
      if (!draft.path || !draft.plan) {
        return (
          <div style={{ padding: 16 }}>
            <p>Plan not generated yet. Going back to the state picker…</p>
          </div>
        );
      }
      return (
        <StagePlan
          draft={draft}
          path={draft.path}
          plan={draft.plan}
          connectedChannels={connectedChannels}
          onBack={() => setStage('state')}
          onAboutEdit={(patch) => {
            const product = draftRef.current.product;
            const next: DraftState = {
              ...draftRef.current,
              product: product
                ? {
                    ...product,
                    ...(patch.name !== undefined ? { name: patch.name } : {}),
                    ...(patch.description !== undefined
                      ? { description: patch.description }
                      : {}),
                    ...(patch.keywords !== undefined
                      ? { keywords: patch.keywords }
                      : {}),
                  }
                : product,
              ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
              ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
            };
            updateDraft(next);
            mirrorToRedis(next);
          }}
          onCommit={async () => {
            if (!draft.path || !draft.plan || !draft.product) {
              throw new Error('Missing plan or product data');
            }
            const state = draft.productState ?? 'launching';
            const body = {
              product: {
                name: draft.product.name,
                description: draft.product.description,
                valueProp: draft.product.valueProp || null,
                keywords: draft.product.keywords,
                category: draft.category,
                targetAudience: draft.audience || null,
                url: draft.product.url || null,
              },
              state,
              launchDate:
                state === 'launching' && draft.launchDate
                  ? new Date(`${draft.launchDate}T00:00:00.000Z`).toISOString()
                  : null,
              launchedAt:
                state === 'launched' && draft.launchedAt
                  ? new Date(`${draft.launchedAt}T00:00:00.000Z`).toISOString()
                  : null,
              // launchChannel + usersBucket are stripped by the backend Zod
              // schema today (stays undefined → field omitted). Left in the
              // payload so when the schema is extended the UI ships zero
              // extra work. Audit finding #5.
              launchChannel:
                state === 'launching' ? draft.launchChannel : null,
              usersBucket: state === 'launched' ? draft.usersBucket : null,
              path: draft.path,
              plan: draft.plan,
            };
            const res = await fetch('/api/onboarding/commit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (!res.ok) {
              const err = (await res.json().catch(() => ({}))) as {
                error?: string;
                detail?: string;
              };
              throw new Error(err.detail || err.error || `Commit failed (${res.status})`);
            }
            window.location.href = '/today?from=onboarding';
          }}
        />
      );
    }
  }
}

function sourceLabelFor(draft: DraftState): string {
  if (draft.sourceKind === 'github' && draft.sourceRepoFullName) {
    return draft.sourceRepoFullName;
  }
  const url = draft.product?.url || draft.sourceUrl;
  if (url) {
    return url.replace(/^https?:\/\//, '');
  }
  return 'manual entry';
}
