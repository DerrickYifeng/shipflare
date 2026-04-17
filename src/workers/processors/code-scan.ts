import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, codeSnapshots } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import {
  cloneRepo,
  cleanupClone,
  scanRepo,
  getCommitSha,
} from '@/services/code-scanner';
import type { CodeScanJobData } from '@/lib/queue/types';

const log = createLogger('worker:code-scan');

/**
 * Worker processor: clone a GitHub repo, scan it, save the snapshot.
 * Publishes progress + result via Redis pub/sub for SSE streaming.
 */
export async function processCodeScan(job: Job<CodeScanJobData>): Promise<void> {
  const { userId, repoFullName, repoUrl, githubToken } = job.data;
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
