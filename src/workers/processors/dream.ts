import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { DreamJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';

const baseLog = createLogger('worker:dream');

/**
 * Distill a single product's accumulated logs into structured memories.
 *
 * DreamJobData carries only productId, so we derive userId from the products
 * row here to satisfy agent_memories.user_id NOT NULL (see 0015 / d7c78dc).
 */
async function distillProduct(productId: string, log: Logger): Promise<void> {
  const [product] = await db
    .select({ userId: products.userId })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  const store = new MemoryStore(product.userId, productId);
  const dream = new AgentDream(store);

  const actions = await dream.distill();

  if (actions.length > 0) {
    const summary = actions
      .map((a) => `${a.action}: ${a.name}`)
      .join(', ');
    log.info(`Product ${productId}: ${actions.length} memory actions — ${summary}`);
  } else {
    log.info(`Product ${productId}: no actions needed`);
  }
}

/**
 * Dream worker: distills accumulated agent observations into
 * structured memories per product.
 *
 * Triggered by:
 * 1. Threshold trigger — after discovery/content runs when log count >= 20
 * 2. Nightly repeatable job — 4am daily safety net (configured in workers/index.ts)
 *
 * When productId is '__all__' (nightly cron), enumerates all products
 * with undistilled logs and distills each.
 */
export async function processDream(job: Job<DreamJobData>) {
  const log = loggerForJob(baseLog, job);
  const { productId } = job.data;

  if (productId === '__all__') {
    const productIds = await MemoryStore.getProductsWithUndistilledLogs();
    log.info(`Nightly distill: ${productIds.length} products with undistilled logs`);
    for (const pid of productIds) {
      await distillProduct(pid, log);
    }
    return;
  }

  await distillProduct(productId, log);
}
