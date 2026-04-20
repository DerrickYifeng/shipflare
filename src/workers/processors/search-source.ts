import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { products, threads, discoveryConfigs } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema, type DiscoveryOutput } from '@/agents/schemas';
import { publishUserEvent } from '@/lib/redis';
import { createPlatformDeps } from '@/lib/platform-deps';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { SearchSourceJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import type { XAIClient } from '@/lib/xai-client';
import {
  classifyAuthorBio,
  judgeAuthorsWithLLM,
  type AuthorVerdict,
} from '@/lib/x-author-filter';
import { getKeyValueClient } from '@/lib/redis';

const baseLog = createLogger('worker:search-source');
const discoverySkill = loadSkill(join(process.cwd(), 'src/skills/discovery'));

export async function processSearchSource(job: Job<SearchSourceJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, platform, source, scanRunId } = job.data;

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const [userConfig] = await db
    .select()
    .from(discoveryConfigs)
    .where(
      and(
        eq(discoveryConfigs.userId, userId),
        eq(discoveryConfigs.platform, platform),
      ),
    )
    .limit(1);

  const deps = await createPlatformDeps(platform, userId);
  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'discovery',
    itemId: `${platform}:${source}`,
    state: 'searching',
  });

  const input: Record<string, unknown> = {
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp ?? '',
    source,
    platform,
  };
  if (userConfig?.calibrationStatus === 'completed') {
    input.scoringConfig = {
      weights: {
        relevance: userConfig.weightRelevance,
        intent: userConfig.weightIntent,
        exposure: userConfig.weightExposure,
        freshness: userConfig.weightFreshness,
        engagement: userConfig.weightEngagement,
      },
      intentGate: userConfig.intentGate,
      relevanceGate: userConfig.relevanceGate,
      gateCap: userConfig.gateCap,
    };
    if (userConfig.customPainPhrases && userConfig.customPainPhrases.length > 0) {
      input.customPainPhrases = userConfig.customPainPhrases;
    }
    if (userConfig.customQueryTemplates && userConfig.customQueryTemplates.length > 0) {
      input.customQueryTemplates = userConfig.customQueryTemplates;
    }
    if (userConfig.strategyRules) {
      input.additionalRules = userConfig.strategyRules;
    }
  }

  const res = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input,
    deps,
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: discoveryOutputSchema,
    runId: traceId,
  });

  const gate = userConfig?.enqueueThreshold ?? 0.7;
  const allThreads = res.results.flatMap((r) => r.threads);

  let candidates = allThreads
    .map((t) => {
      const relevanceScore = t.relevanceScore != null
        ? t.relevanceScore / 100
        : ((t.relevance ?? 0) + (t.intent ?? 0)) / 2;
      return { t, relevanceScore };
    })
    .filter((c) => c.relevanceScore >= 0.3);

  // X-only: two-stage filter (regex rules → Haiku LLM) to drop competitors
  // and growth-marketing grifters BEFORE we persist threads. Upstream filtering
  // is cheaper than filtering at the drafter layer and keeps the Today queue
  // clean of dead candidates. Verdicts are cached in Redis per (product,
  // handle) for 14 days so repeat authors cost nothing across discovery runs.
  if (platform === 'x' && candidates.length > 0) {
    const xaiClient = deps.xaiClient as XAIClient | undefined;
    if (xaiClient) {
      const authors = [
        ...new Set(
          candidates
            .map((c) => c.t.author?.trim())
            .filter((a): a is string => Boolean(a && a.length > 0)),
        ),
      ];
      if (authors.length > 0) {
        try {
          const redis = getKeyValueClient();
          const cacheKey = (handle: string) =>
            `x-author-verdict:${productId}:${handle.toLowerCase()}`;
          const CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

          // Stage 0 — check Redis cache.
          const cacheResults = await Promise.all(
            authors.map(async (h) => {
              const raw = await redis.get(cacheKey(h));
              if (!raw) return { handle: h, verdict: null };
              try {
                return {
                  handle: h,
                  verdict: JSON.parse(raw) as AuthorVerdict,
                };
              } catch {
                return { handle: h, verdict: null };
              }
            }),
          );

          const verdicts = new Map<string, AuthorVerdict>();
          const needLookup: string[] = [];
          for (const { handle, verdict } of cacheResults) {
            if (verdict) {
              verdicts.set(handle.toLowerCase(), verdict);
            } else {
              needLookup.push(handle);
            }
          }

          if (needLookup.length > 0) {
            // Stage 1 — fetch bios + regex rules pre-filter (0 cost).
            const bios = await xaiClient.fetchUserBios(needLookup);
            const bioMap = new Map(
              bios.map((b) => [b.username.toLowerCase(), b.bio]),
            );

            const ambiguous: Array<{ username: string; bio: string | null }> = [];
            for (const handle of needLookup) {
              const bio = bioMap.get(handle.toLowerCase()) ?? null;
              const ruleMatch = classifyAuthorBio(bio);
              if (ruleMatch.isCompetitor) {
                verdicts.set(handle.toLowerCase(), {
                  username: handle,
                  isCompetitor: true,
                  reason: ruleMatch.reason ?? 'rule block',
                  decidedBy: 'rule',
                });
              } else if (!bio) {
                // Unknown bio (Grok didn't resolve, or truly empty) — default
                // pass, don't over-block on missing data.
                verdicts.set(handle.toLowerCase(), {
                  username: handle,
                  isCompetitor: false,
                  reason: 'bio unknown — default pass',
                  decidedBy: 'default',
                });
              } else {
                ambiguous.push({ username: handle, bio });
              }
            }

            // Stage 2 — LLM judges remaining ambiguous bios against product.
            if (ambiguous.length > 0) {
              const { verdicts: llmVerdicts } = await judgeAuthorsWithLLM(
                {
                  name: product.name,
                  description: product.description,
                  valueProp: product.valueProp,
                },
                ambiguous,
              );
              for (const v of llmVerdicts) {
                verdicts.set(v.username.toLowerCase(), v);
              }
            }

            // Persist all freshly decided verdicts.
            await Promise.all(
              needLookup.map((handle) => {
                const v = verdicts.get(handle.toLowerCase());
                if (!v) return Promise.resolve();
                return redis.set(
                  cacheKey(handle),
                  JSON.stringify(v),
                  'EX',
                  CACHE_TTL_SECONDS,
                );
              }),
            );
          }

          // Filter candidates by combined verdicts.
          const before = candidates.length;
          const dropped: Array<{ author: string; reason: string; by: string }> = [];
          candidates = candidates.filter((c) => {
            const author = c.t.author?.trim().toLowerCase();
            if (!author) return true;
            const verdict = verdicts.get(author);
            if (verdict?.isCompetitor) {
              dropped.push({
                author,
                reason: verdict.reason,
                by: verdict.decidedBy,
              });
              return false;
            }
            return true;
          });

          if (dropped.length > 0) {
            log.info(
              `bio filter dropped ${dropped.length}/${before} X candidates — ${dropped
                .slice(0, 5)
                .map((d) => `@${d.author}[${d.by}:${d.reason}]`)
                .join(', ')}${dropped.length > 5 ? '…' : ''}`,
            );
          }
        } catch (bioErr) {
          log.warn(
            `bio filter failed, passing all candidates through: ${bioErr}`,
          );
        }
      }
    }
  }

  const rows = candidates.map((c) => ({
    userId,
    externalId: c.t.id,
    platform,
    community: c.t.community,
    title: c.t.title,
    body: c.t.body ?? null,
    author: c.t.author ?? null,
    url: c.t.url,
    upvotes: typeof c.t.score === 'number' ? c.t.score : null,
    commentCount: typeof c.t.commentCount === 'number' ? c.t.commentCount : null,
    postedAt: c.t.postedAt ? new Date(c.t.postedAt) : null,
    relevanceScore: c.relevanceScore,
    sourceJobId: job.id ?? null,
    state: 'queued' as const,
  }));
  const shouldEnqueue = new Set(
    candidates.filter((c) => c.relevanceScore >= gate).map((c) => c.t.id),
  );

  let inserted: Array<{ id: string; externalId: string }> = [];
  if (rows.length > 0) {
    inserted = await db
      .insert(threads)
      .values(rows)
      .onConflictDoNothing({ target: [threads.userId, threads.platform, threads.externalId] })
      .returning({ id: threads.id, externalId: threads.externalId });
  }

  // Phase 2 migration: the content queue was retired along with the
  // compound content agent. Downstream draft generation will route through
  // the plan-execute dispatcher in Phase 7. For now, above-gate threads are
  // still written to the `threads` table so the reply journey UI can pick
  // them up once that path lands.
  void shouldEnqueue;
  void inserted;
  void productId;
  void traceId;

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'discovery',
    itemId: `${platform}:${source}`,
    state: 'searched',
    data: { found: rows.length, aboveGate: inserted.length, source, platform },
  });
  await recordPipelineEvent({
    userId,
    productId,
    stage: 'source_searched',
    cost: res.usage.costUsd,
    metadata: { platform, source, scanRunId, found: rows.length },
  });

  log.info(
    `search-source ${platform}:${source} — found ${rows.length}, gated ${inserted.length}`,
  );
}
