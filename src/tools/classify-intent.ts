import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { buildTool } from '@/bridge/build-tool';

const CLASSIFY_SYSTEM_PROMPT = `You are an intent classifier for social media posts. Given a post title, body, and product context, classify the post's intent across three layers.

Respond with ONLY a JSON object, no commentary.

## Layer 1: Content Type (what kind of post is this?)
- solution_request: asking for tool/product recommendations
- advice_request: asking for advice/resources
- pain_point: complaining/venting about a problem
- money_talk: discussing budgets/pricing/costs
- discussion: general topic discussion
- show_and_tell: sharing own work/project

## Layer 2: Buyer Stage (where is the poster in the buying journey?)
- problem_aware: knows they have a problem, hasn't started looking for solutions
- solution_aware: researching solution categories
- product_aware: comparing specific products
- purchase_ready: ready to buy, looking for best option
- recently_purchased: just bought something (competitor intelligence)
- none: no buying intent

## Layer 3: Need Signals
- posterNeed: does the poster themselves need a solution?
  - type: seeking_recommendation | seeking_alternative | expressing_frustration | describing_pain | null
  - strength: 0.0-1.0 (action language + specificity + budget/timeline mentions)
- readerNeed: would readers of this post benefit from the product?
  - strength: 0.0-1.0 (high upvotes on pain post, +1 comments, recurring topic)

Output JSON schema:
{
  "contentType": string,
  "buyerStage": string,
  "posterNeed": { "present": boolean, "type": string|null, "strength": number },
  "readerNeed": { "present": boolean, "strength": number },
  "overallIntent": number,
  "reason": string
}`;

const client = new Anthropic();

export const classifyIntentTool = buildTool({
  name: 'classify_intent',
  description:
    'Classify post intent: content type, buyer stage, and poster-need vs reader-need signal. Uses LLM for semantic understanding.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    title: z.string().describe('Post title'),
    body: z.string().describe('Post body (can be truncated)'),
    metadata: z.object({
      upvotes: z.number().nullable().optional(),
      commentCount: z.number().nullable().optional(),
      platform: z.string(),
    }),
    productContext: z.string().describe('One-line product description for relevance judgment'),
  }),
  async execute(input) {
    const userMessage = `Post title: ${input.title}
Post body: ${input.body.slice(0, 1500)}
Platform: ${input.metadata.platform}
Upvotes: ${input.metadata.upvotes ?? 'unknown'}
Comments: ${input.metadata.commentCount ?? 'unknown'}
Product context: ${input.productContext}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Strip markdown code fences if present (```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object in response');

    const parsed = JSON.parse(jsonMatch[0]) as {
      contentType: string;
      buyerStage: string;
      posterNeed: { present: boolean; type: string | null; strength: number };
      readerNeed: { present: boolean; strength: number };
      overallIntent: number;
      reason: string;
    };

    return parsed;
  },
});
