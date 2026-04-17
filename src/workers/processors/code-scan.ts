import type { Job } from 'bullmq';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, codeSnapshots, channels, discoveryConfigs } from '@/lib/db/schema';
import { accounts } from '@/lib/db/schema/users';
import { getPubSubPublisher } from '@/lib/redis';
import { enqueueCalibration, codeScanQueue } from '@/lib/queue';
import { isPlatformAvailable } from '@/lib/platform-config';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import {
  cloneRepo,
  cleanupClone,
  scanRepo,
  getCommitSha,
  diffRepo,
} from '@/services/code-scanner';
import type { CodeScanJobData } from '@/lib/queue/types';

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
    // Resolve GitHub token from the user's Auth.js accounts table
    const [ghAccount] = await db
      .select({ accessToken: accounts.access_token })
      .from(accounts)
      .where(eq(accounts.userId, snap.userId))
      .limit(1);

    if (!ghAccount?.accessToken) {
      log.warn(`No GitHub token for user ${snap.userId}, skipping daily diff`);
      continue;
    }

    await codeScanQueue.add(
      'daily-diff',
      {
        userId: snap.userId,
        repoFullName: snap.repoFullName,
        repoUrl: '',
        githubToken: ghAccount.accessToken,
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
      // Create a product from scan results
      const [newProduct] = await db
        .insert(products)
        .values({
          userId,
          url: repoUrl,
          name: scanResult.productAnalysis.productName,
          description: scanResult.productAnalysis.oneLiner,
          keywords: scanResult.productAnalysis.keywords,
          valueProp: scanResult.productAnalysis.valueProp,
        })
        .returning({ id: products.id });
      productId = newProduct.id;

      // Trigger calibration for new product created from code scan
      const userChannels = await db
        .select({ platform: channels.platform })
        .from(channels)
        .where(eq(channels.userId, userId));

      const platforms = [
        ...new Set(userChannels.map((c) => c.platform)),
      ].filter(isPlatformAvailable);

      for (const platform of platforms) {
        await db
          .insert(discoveryConfigs)
          .values({ userId, platform, calibrationStatus: 'pending' })
          .onConflictDoNothing();
      }

      if (platforms.length > 0) {
        await enqueueCalibration({ userId, productId });
        log.info(`Enqueued calibration for code-scanned product ${productId}`);
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

    // Phase 5: Publish result
    const extractedProfile = {
      url: repoUrl,
      name: scanResult.productAnalysis.productName,
      description: scanResult.productAnalysis.oneLiner,
      keywords: scanResult.productAnalysis.keywords,
      valueProp: scanResult.productAnalysis.valueProp,
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
