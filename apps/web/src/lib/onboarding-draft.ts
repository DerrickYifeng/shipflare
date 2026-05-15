import type { DB } from "@shipflare/db";
import { onboardingDrafts, eq } from "@shipflare/db";

export interface OnboardingDraft {
  source?: "url" | "github" | "manual";
  url?: string | null;
  githubRepo?: string | null;
  name?: string;
  description?: string;
  valueProp?: string | null;
  keywords?: string[];
  targetAudience?: string | null;
  category?:
    | "dev_tool"
    | "saas"
    | "consumer"
    | "creator_tool"
    | "agency"
    | "ai_app"
    | "other";
  reviewed?: boolean;
  channels?: Array<"x" | "reddit" | "email">;
  state?: "mvp" | "launching" | "launched";
  launchDate?: string | null;
  launchedAt?: string | null;
  launchChannel?: "producthunt" | "showhn" | "both" | "other" | null;
  usersBucket?: "<100" | "100-1k" | "1k-10k" | "10k+" | null;
  previewPath?: unknown;
  updatedAt?: string;
}

export async function getDraft(
  db: DB,
  userId: string,
): Promise<OnboardingDraft | null> {
  const row = await db
    .select()
    .from(onboardingDrafts)
    .where(eq(onboardingDrafts.userId, userId))
    .get();
  if (!row) return null;
  return row.payload as OnboardingDraft;
}

export async function putDraft(
  db: DB,
  userId: string,
  patch: Partial<OnboardingDraft>,
): Promise<OnboardingDraft> {
  const existing = await getDraft(db, userId);
  const next: OnboardingDraft = {
    ...(existing ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(onboardingDrafts)
    .values({
      userId,
      payload: next as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: onboardingDrafts.userId,
      set: {
        payload: next as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
  return next;
}

export async function deleteDraft(
  db: DB,
  userId: string,
): Promise<void> {
  await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));
}
