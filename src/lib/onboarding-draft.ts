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
 * Merge-upsert the draft. Reads the existing draft, shallow-merges
 * the patch, writes back with a refreshed 1h TTL. When no prior
 * draft exists the patch is written as-is.
 *
 * Merge is intentionally shallow — nested objects (e.g. `previewPath`)
 * are replaced wholesale rather than deep-merged. Callers that want
 * to touch nested state send the full nested object.
 */
export async function putDraft(
  userId: string,
  patch: Partial<OnboardingDraft>,
): Promise<void> {
  try {
    const kv = getKeyValueClient();
    const existing = await getDraft(userId);
    const next: OnboardingDraft = {
      ...(existing ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await kv.set(key(userId), JSON.stringify(next), 'EX', TTL_SECONDS);
  } catch (err) {
    log.warn(
      `putDraft failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
