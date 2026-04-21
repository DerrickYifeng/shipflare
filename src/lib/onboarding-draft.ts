import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:onboarding-draft');

/**
 * The Redis-backed onboarding draft. Partial snapshot of what the
 * user has entered across stages so they can resume if they refresh
 * mid-flow. NOT the final product — /commit is what persists.
 *
 * Shape matches the frontend onboarding spec §2 (draft state). Every
 * field is optional; undefined means "not yet entered". Keep the
 * shape permissive — frontend adds new fields between phases and we
 * don't want to schema-churn the backend every time.
 */
export interface OnboardingDraft {
  // Step 1 — source
  source?: 'url' | 'github' | 'manual';
  url?: string | null;
  githubRepo?: string | null;
  // Extracted / entered profile
  name?: string;
  description?: string;
  valueProp?: string | null;
  keywords?: string[];
  targetAudience?: string | null;
  category?:
    | 'dev_tool'
    | 'saas'
    | 'consumer'
    | 'creator_tool'
    | 'agency'
    | 'ai_app'
    | 'other';
  // Step 4 — connect (mirror of channels table, read-only here)
  channels?: Array<'x' | 'reddit' | 'email'>;
  // Step 5 — state picker
  state?: 'mvp' | 'launching' | 'launched';
  launchDate?: string | null;
  launchedAt?: string | null;
  // Step 7 — plan preview cache
  previewPath?: unknown;
  previewPlan?: unknown;
  // Audit
  updatedAt?: string;
}

const TTL_SECONDS = 60 * 60; // 1h rolling

function key(userId: string): string {
  return `onboarding:${userId}`;
}

/**
 * Read the draft for a user. Returns null when no draft exists or the
 * Redis value can't be parsed. Silent failure — draft storage is
 * best-effort UX, not correctness-critical.
 */
export async function getDraft(userId: string): Promise<OnboardingDraft | null> {
  try {
    const kv = getKeyValueClient();
    const raw = await kv.get(key(userId));
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingDraft;
  } catch (err) {
    log.warn(
      `getDraft failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Merge-upsert the draft. Atomic via Redis WATCH + MULTI/EXEC so two
 * concurrent `putDraft` calls for the same user can't leapfrog each
 * other. On optimistic-lock contention, retries up to `MAX_RETRIES`
 * with a fresh read each time — the last writer wins, but writes
 * aren't lost.
 *
 * Merge is intentionally shallow — nested objects (e.g. `previewPath`)
 * are replaced wholesale rather than deep-merged. Callers that want
 * to touch nested state send the full nested object.
 */
const MAX_RETRIES = 5;

export async function putDraft(
  userId: string,
  patch: Partial<OnboardingDraft>,
): Promise<void> {
  const kv = getKeyValueClient();
  const k = key(userId);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await kv.watch(k);
      const raw = await kv.get(k);
      const existing = raw ? (JSON.parse(raw) as OnboardingDraft) : null;
      const next: OnboardingDraft = {
        ...(existing ?? {}),
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const result = await kv
        .multi()
        .set(k, JSON.stringify(next), 'EX', TTL_SECONDS)
        .exec();
      // `exec()` returns `null` when WATCH noticed a change between
      // WATCH and EXEC — retry the whole read-modify-write.
      if (result !== null) return;
    } catch (err) {
      // Abandon the WATCH and surface the failure at warn. A single
      // lost write is acceptable; the draft is a UX nicety.
      try {
        await kv.unwatch();
      } catch {
        /* ignore */
      }
      log.warn(
        `putDraft failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  log.warn(
    `putDraft user=${userId} gave up after ${MAX_RETRIES} CAS retries`,
  );
}

/** Remove the draft. Idempotent; errors are silent. */
export async function deleteDraft(userId: string): Promise<void> {
  try {
    const kv = getKeyValueClient();
    await kv.del(key(userId));
  } catch (err) {
    log.warn(
      `deleteDraft failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
