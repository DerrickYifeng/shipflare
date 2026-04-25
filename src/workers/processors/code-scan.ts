import type { Job } from 'bullmq';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, codeSnapshots, channels } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { codeScanQueue } from '@/lib/queue';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import { getGitHubToken } from '@/lib/github';
import {
  cloneRepo,
  cleanupClone,
  scanRepo,
  getCommitSha,
  diffRepo,
} from '@/services/code-scanner';
import type { CodeScanJobData } from '@/lib/queue/types';
import type { ScanResult } from '@/types/code-scanner';

/**
 * Best-effort homepage extraction from a scanned repo. Returns null when no
 * real product URL is found — callers then leave `products.url` null rather
 * than falling back to the repo URL (which is preserved separately in
 * `code_snapshots.repo_url`).
 *
 * Priority:
 *  1. `package.json → homepage` (excluding github.com to avoid re-leaking the
 *     repo URL when authors point homepage at their own repo).
 *  2. First non-github, non-package-registry absolute URL in the README.
 */
function extractHomepage(scan: ScanResult): string | null {
  // 1. package.json homepage field. The ManifestInfo type currently doesn't
  //    carry this through, so re-parse the raw key file when present.
  const pkgFile = scan.keyFiles.find((f) => f.path.endsWith('package.json'));
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { homepage?: unknown };
      if (typeof pkg.homepage === 'string' && isPlausibleHomepage(pkg.homepage)) {
        return pkg.homepage;
      }
    } catch {
      // malformed JSON — fall through
    }
  }

  // 2. Scan README for the first plausible homepage URL.
  if (scan.readme) {
    const matches = scan.readme.match(/https?:\/\/[^\s)'"<>\]]+/g) ?? [];
    for (const url of matches) {
      if (isPlausibleHomepage(url)) return url;
    }
  }

  return null;
}

function isPlausibleHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    if (host.endsWith('github.com') || host.endsWith('github.io')) return false;
    if (host.endsWith('npmjs.com') || host.endsWith('npmjs.org')) return false;
    if (host.endsWith('gitlab.com') || host.endsWith('bitbucket.org')) return false;
    if (host.endsWith('shields.io') || host.endsWith('badge.fury.io')) return false;
    return true;
  } catch {
    return false;
  }
}

const baseLog = createLogger('worker:code-scan');

/**
 * Daily diff: clone the repo and compare HEAD against the stored snapshot.
 * Updates diffSummary and changesDetected on the code_snapshots row.
 */
async function processDailyDiff(
  snapshot: { id: string; repoFullName: string; commitSha: string | null; userId: string },
  githubToken: string,
  log: Logger,
): Promise<void> {
  let cloneDir: string | null = null;
  try {
    cloneDir = await cloneRepo(snapshot.repoFullName, githubToken);
    const result = await diffRepo(cloneDir, snapshot.commitSha);

    if (result.hasMeaningfulChanges) {
      await db
        .update(codeSnapshots)
        .set({
          commitSha: result.newCommitSha,
          diffSummary: result.diffSummary,
          changesDetected: true,
          lastDiffAt: new Date(),
          scannedAt: new Date(),
        })
        .where(eq(codeSnapshots.id, snapshot.id));
      log.info(`Daily diff for ${snapshot.repoFullName}: meaningful changes detected`);
    } else {
      await db
        .update(codeSnapshots)
        .set({
          commitSha: result.newCommitSha ?? snapshot.commitSha,
          changesDetected: false,
          lastDiffAt: new Date(),
        })
        .where(eq(codeSnapshots.id, snapshot.id));
      log.info(`Daily diff for ${snapshot.repoFullName}: no meaningful changes`);
    }
  } finally {
    if (cloneDir) await cleanupClone(cloneDir);
  }
}

/**
 * Cron fan-out: enqueue daily diff jobs for all users with code snapshots.
 */
async function fanOutDailyDiff(log: Logger): Promise<void> {
  // Find all code snapshots that have a repo linked
  const snapshots = await db
    .select({
      id: codeSnapshots.id,
      userId: codeSnapshots.userId,
      repoFullName: codeSnapshots.repoFullName,
      commitSha: codeSnapshots.commitSha,
    })
    .from(codeSnapshots)
    .where(isNotNull(codeSnapshots.repoFullName));

  log.info(`Daily diff fan-out: ${snapshots.length} repos to check`);

  for (const snap of snapshots) {
    const accessToken = await getGitHubToken(snap.userId);
    if (!accessToken) {
      log.warn(`No GitHub token for user ${snap.userId}, skipping daily diff`);
      continue;
    }

    await codeScanQueue.add(
      'daily-diff',
      {
        userId: snap.userId,
        repoFullName: snap.repoFullName,
        repoUrl: '',
        githubToken: accessToken,
        isDailyDiff: true,
      },
      { jobId: `daily-diff-${snap.id}-${Date.now()}` },
    );
  }
}

/**
 * Worker processor: clone a GitHub repo, scan it, save the snapshot.
 * Publishes progress + result via Redis pub/sub for SSE streaming.
 */
export async function processCodeScan(job: Job<CodeScanJobData>): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { userId, repoFullName, repoUrl, githubToken, isDailyDiff } = job.data;

  // Cron fan-out: enqueue individual diff jobs for all users
  if (isDailyDiff && userId === '__all__') {
    await fanOutDailyDiff(log);
    return;
  }

  // Individual daily diff: compare HEAD against stored snapshot
  if (isDailyDiff) {
    const [snap] = await db
      .select({
        id: codeSnapshots.id,
        repoFullName: codeSnapshots.repoFullName,
        commitSha: codeSnapshots.commitSha,
        userId: codeSnapshots.userId,
      })
      .from(codeSnapshots)
      .where(eq(codeSnapshots.userId, userId))
      .limit(1);

    if (!snap) {
      log.warn(`No code snapshot for user ${userId}, skipping daily diff`);
      return;
    }

    await processDailyDiff(snap, githubToken, log);
    return;
  }

  // Full scan (onboarding flow)
  const channel = `code-scan:${userId}`;
  const redis = getPubSubPublisher();

  let cloneDir: string | null = null;

  try {
    // Phase 1: Clone
    await publishProgress(redis, channel, 'cloning', 'Cloning repository...');
    cloneDir = await cloneRepo(repoFullName, githubToken);

    // Phase 2: Scan
    await publishProgress(redis, channel, 'scanning', 'Scanning files...');
    const scanResult = await scanRepo(cloneDir);

    // Pull a real homepage out of the README / package.json when possible.
    // Falls back to null so we don't leak the repo URL into products.url;
    // the repo URL is still preserved on code_snapshots.repo_url.
    const homepage = extractHomepage(scanResult);

    // Phase 3: Get commit SHA
    const commitSha = await getCommitSha(cloneDir);

    // Phase 4: Find or create product, then save snapshot
    await publishProgress(redis, channel, 'saving', 'Analyzing and saving...');

    // Find user's product (should exist from onboarding profile save, but handle gracefully)
    const existingProducts = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.userId, userId))
      .limit(1);

    let productId: string;

    if (existingProducts[0]) {
      productId = existingProducts[0].id;
    } else {
      // Create a product from scan results. Only populate `url` when we
      // recovered a real homepage — the repo URL continues to live on
      // code_snapshots.repo_url.
      const [newProduct] = await db
        .insert(products)
        .values({
          userId,
          url: homepage,
          name: scanResult.productAnalysis.productName,
          description: scanResult.productAnalysis.oneLiner,
          keywords: scanResult.productAnalysis.keywords,
          valueProp: scanResult.productAnalysis.valueProp,
        })
        .returning({ id: products.id });
      productId = newProduct.id;

      // Discovery v3: no calibration. The first discovery-scan for this
      // product generates the onboarding rubric lazily via
      // `generateOnboardingRubric`; no per-platform config rows needed.

      // Phase F: seed the team roster for the newly-scanned product. Best-
      // effort — if it fails the scan job still succeeds and the team will
      // be provisioned lazily by the next plan-execute or /api/onboarding/plan.
      try {
        const { provisionTeamForProduct } = await import(
          '@/lib/team-provisioner'
        );
        const provision = await provisionTeamForProduct(userId, productId);
        log.info(
          `provisionTeamForProduct post-code-scan: team=${provision.teamId} preset=${provision.preset}`,
        );
      } catch (err) {
        // Surface the real Postgres cause, not just "Failed query: <SQL>".
        // Drizzle wraps the driver error; the useful details live on
        // `.cause` (pg error with .code / .message) or in the stack.
        const message = err instanceof Error ? err.message : String(err);
        const cause =
          err instanceof Error && err.cause
            ? err.cause instanceof Error
              ? `${err.cause.message}${(err.cause as { code?: string }).code ? ` [${(err.cause as { code?: string }).code}]` : ''}`
              : String(err.cause)
            : undefined;
        log.warn(
          `provisionTeamForProduct post-code-scan failed (non-fatal): ${message}${cause ? ` — cause: ${cause}` : ''}`,
        );
      }
    }

    // Upsert code snapshot
    const existing = await db
      .select({ id: codeSnapshots.id })
      .from(codeSnapshots)
      .where(eq(codeSnapshots.productId, productId))
      .limit(1);

    if (existing[0]) {
      await db
        .update(codeSnapshots)
        .set({
          repoFullName,
          repoUrl,
          techStack: scanResult.techStack,
          fileTree: scanResult.fileTree,
          keyFiles: scanResult.keyFiles,
          scanSummary: scanResult.productAnalysis.oneLiner,
          commitSha,
          scannedAt: new Date(),
        })
        .where(eq(codeSnapshots.id, existing[0].id));
    } else {
      await db.insert(codeSnapshots).values({
        userId,
        productId,
        repoFullName,
        repoUrl,
        techStack: scanResult.techStack,
        fileTree: scanResult.fileTree,
        keyFiles: scanResult.keyFiles,
        scanSummary: scanResult.productAnalysis.oneLiner,
        commitSha,
      });
    }

    // Phase 5: Publish result. `url` is the extracted homepage (or null) —
    // never the repo URL, which stays on code_snapshots.repo_url.
    const extractedProfile = {
      url: homepage,
      name: scanResult.productAnalysis.productName,
      description: scanResult.productAnalysis.oneLiner,
      keywords: scanResult.productAnalysis.keywords,
      valueProp: scanResult.productAnalysis.valueProp,
      targetAudience: scanResult.productAnalysis.targetAudience,
      ogImage: null,
      seoAudit: null,
    };

    await redis.publish(channel, JSON.stringify({
      type: 'complete',
      data: extractedProfile,
    }));

    log.info(`Code scan complete for ${repoFullName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Code scan failed for ${repoFullName}: ${message}`);

    try {
      await redis.publish(channel, JSON.stringify({
        type: 'error',
        error: message,
      }));
    } catch (pubErr) {
      log.error(`Failed to publish error event: ${pubErr}`);
    }

    throw error;
  } finally {
    if (cloneDir) {
      await cleanupClone(cloneDir);
    }
  }
}

async function publishProgress(
  redis: ReturnType<typeof getPubSubPublisher>,
  channel: string,
  phase: string,
  message: string,
): Promise<void> {
  await redis.publish(channel, JSON.stringify({
    type: 'progress',
    phase,
    message,
  }));
}
