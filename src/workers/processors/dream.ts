import type { Job } from 'bullmq';
import type { DreamJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';

const log = createLogger('worker:dream');

/**
 * Distill a single product's accumulated logs into structured memories.
 */
async function distillProduct(productId: string): Promise<void> {
  const store = new MemoryStore(productId);
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
  const { productId } = job.data;

  if (productId === '__all__') {
    const productIds = await MemoryStore.getProductsWithUndistilledLogs();
    log.info(`Nightly distill: ${productIds.length} products with undistilled logs`);
    for (const pid of productIds) {
      await distillProduct(pid);
    }
    return;
  }

  await distillProduct(productId);
}
