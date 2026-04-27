/**
 * Onboarding rubric generator.
 *
 * Runs once per product during onboarding. Takes the product context and
 * produces a structured "who is the target customer" rubric that the
 * discovery-scout agent will read out of MemoryStore on every run.
 *
 * This replaces the cold-start problem the legacy calibration loop was
 * trying to solve: without labels, scout has no taste. With a rubric in
 * memory, scout has a defensible starting point; the reviewer (PR 3) and
 * real user approve/skip actions refine it from there.
 *
 * Written as a pure function so the caller controls when it runs (we
 * recommend an async job, awaited before the first discovery-scan fires
 * for the product).
 */

import { z } from 'zod';
import { createMessage, calculateCost } from '@/core/api-client';
import { MemoryStore } from '@/memory/store';
import { createLogger } from '@/lib/logger';
import type { UsageSummary } from '@/core/types';

const log = createLogger('lib:discovery:onboarding-rubric');

const MODEL = 'claude-sonnet-4-6';

/**
 * Memory entry name the rubric is stored under. Scout's `<agent-memory>`
 * index renders every entry, so choosing a stable, descriptive name
 * matters — it's what the model reads in the index before deciding
 * whether to fetch the full content.
 */
export const ONBOARDING_RUBRIC_MEMORY_NAME = 'discovery-rubric';

export interface OnboardingRubricInput {
  userId: string;
  productId: string;
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
  };
}

export interface OnboardingRubricResult {
  /** The rubric content, as written to MemoryStore. Returned for
   * observability — callers typically just need to know it succeeded. */
  rubric: string;
  usage: UsageSummary;
}

const SYSTEM_PROMPT = `You are writing an onboarding rubric that the Discovery Scout agent will read on every run. The rubric defines, for ONE specific product, who counts as a "target customer whose thread is worth replying to" on X/Twitter and Reddit.

The scout uses this rubric to make queue-or-skip decisions on public posts. Your rubric is the seed of its taste before real user feedback arrives.

Write in direct, operational prose — no hedging, no marketing voice. Every statement must be specific enough that a reader could apply it to a real post in under 5 seconds.

Structure the rubric as exactly four sections, in this order:

## Ideal target customer
Who fits the product's actual ICP. Describe the persona in terms of what they *say* and *do* in public — their job title (only if load-bearing), the problems they publish, the tools they discuss, the stage of work they're in. 3-6 bullets. Be concrete: "solo founder running a SaaS with < $10k MRR" beats "SaaS users".

## Not a fit
Who looks superficially relevant but isn't. Include: direct category competitors (name them by category, not by specific company), pure info-product sellers whose audience doesn't overlap the product, grifter personas (growth-bait, engagement pod, $X/mo funnel), and any persona the product has a specific reason to avoid. 3-6 bullets. Each bullet must explain *why* the fit fails.

## Gray zone
Personas where the call could go either way. Name the signal that would flip the verdict. 2-4 bullets. Example format: "Agency ICs — queue only if they publish their own product updates alongside client work; skip if all output is client-facing."

## Key signals (in thread text)
Concrete phrases, pain points, or workflows that are high-signal for "this person would welcome a product-relevant reply". 4-8 bullets. These are what the scout will pattern-match against in the actual tweet/post text, so write them as phrases the customer would plausibly use.

Hard rules:
- Do NOT include a preamble, a closing paragraph, or any text outside the four sections.
- Do NOT name specific competitor companies — categories only (e.g. "Zapier-style no-code automation tools" not "Zapier").
- Do NOT invent product capabilities the description doesn't state.
- Keep the total under 700 words. The rubric lives in memory forever — density matters.`;

const outputShapeSchema = z.object({
  rubric: z.string().min(200),
});

function buildUserMessage(product: OnboardingRubricInput['product']): string {
  const kw = product.keywords.length > 0
    ? product.keywords.map((k) => `- ${k}`).join('\n')
    : '(none provided)';
  return [
    'Product context:',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(none provided)'}`,
    'Keywords:',
    kw,
    '',
    'Write the four-section rubric now. Output the markdown directly — do not wrap it in JSON, do not add a preamble.',
  ].join('\n');
}

export async function generateOnboardingRubric(
  input: OnboardingRubricInput,
  opts?: { signal?: AbortSignal },
): Promise<OnboardingRubricResult> {
  const { response, usage: rawUsage } = await createMessage({
    model: MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(input.product) }],
    maxTokens: 2048,
    promptCaching: false,
    signal: opts?.signal,
  });

  const rubric = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();

  const parse = outputShapeSchema.safeParse({ rubric });
  if (!parse.success) {
    throw new Error(
      `onboarding-rubric: model returned unusable output (length=${rubric.length}): ${parse.error.message}`,
    );
  }

  const store = new MemoryStore(input.userId, input.productId);
  await store.saveEntry({
    name: ONBOARDING_RUBRIC_MEMORY_NAME,
    description: `Target-customer rubric for ${input.product.name}. Read first on every discovery run.`,
    type: 'user',
    content: parse.data.rubric,
  });

  const usage: UsageSummary = {
    ...rawUsage,
    costUsd: calculateCost(MODEL, rawUsage),
    model: MODEL,
    turns: 1,
  };

  log.info(
    `onboarding rubric written (product=${input.productId}, chars=${parse.data.rubric.length}, cost=$${usage.costUsd.toFixed(4)})`,
  );

  return { rubric: parse.data.rubric, usage };
}
