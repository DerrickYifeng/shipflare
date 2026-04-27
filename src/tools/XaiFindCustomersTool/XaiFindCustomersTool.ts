import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { ToolDefinition } from '@/core/types';
import { XAIClient } from '@/lib/xai-client';
import type { ConversationalMessage } from '@/lib/xai-client';
import { createLogger } from '@/lib/logger';
import { toXaiJsonSchema } from './json-schema-helper';
import {
  xaiFindCustomersResponseSchema,
  type TweetCandidate,
} from './schema';

const log = createLogger('tool:xai_find_customers');

export const XAI_FIND_CUSTOMERS_TOOL_NAME = 'xai_find_customers';

/** Stable JSON schema name xAI sees in the response_format envelope. */
const RESPONSE_FORMAT_NAME = 'CustomerTweets';

const productContextSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  valueProp: z.string().nullable(),
  targetAudience: z.string().nullable(),
  keywords: z.array(z.string()),
});

const inputSchema = z.object({
  /** Full xAI conversation history; agent appends each call. */
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  /** Product fields injected into the first user message context section
   *  (the agent decides when/how to render them — usually only on the
   *  first turn since xAI history carries them forward). */
  productContext: productContextSchema,
  /** Default false → fast non-reasoning Grok variant. Agent escalates to
   *  true after 2 weak rounds. See discovery-agent AGENT.md. */
  reasoning: z.boolean().default(false),
});

export interface XaiFindCustomersResult {
  tweets: TweetCandidate[];
  notes: string;
  assistantMessage: ConversationalMessage;
  /** Token usage so the agent / observability layer can report. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** Cache one client per process — XAIClient holds only an API key. */
let cachedClient: XAIClient | null = null;
function getClient(): XAIClient {
  if (!cachedClient) cachedClient = new XAIClient();
  return cachedClient;
}

function resolveModel(reasoning: boolean): string {
  if (reasoning) {
    return process.env.XAI_MODEL_REASONING ?? 'grok-4.20-reasoning';
  }
  return process.env.XAI_MODEL_FAST ?? 'grok-4.20-non-reasoning';
}

export const xaiFindCustomersTool = buildTool({
  name: XAI_FIND_CUSTOMERS_TOOL_NAME,
  description:
    'Conversational X/Twitter search via xAI Grok with structured JSON ' +
    'output. Pass the full prior xAI message history each call so Grok ' +
    'understands refinements in context. Returns tweets matching the ' +
    'product ICP with engagement stats + author bios. Set `reasoning: true` ' +
    'to escalate to the reasoning-enabled Grok model after weak initial ' +
    'rounds (2-5x cost, deeper analysis).',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: true,
  async execute(input, ctx): Promise<XaiFindCustomersResult> {
    const model = resolveModel(input.reasoning ?? false);
    const modeLabel = (input.reasoning ?? false) ? 'reasoning' : 'fast';

    ctx.emitProgress?.(
      'xai_find_customers',
      `Asking Grok (${modeLabel}) for ICP-matching tweets…`,
      { model, reasoning: input.reasoning, messageCount: input.messages.length },
    );

    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: RESPONSE_FORMAT_NAME,
        schema: toXaiJsonSchema(xaiFindCustomersResponseSchema),
        strict: true,
      },
    };

    const result = await getClient().respondConversational({
      model,
      messages: input.messages,
      tools: [{ type: 'x_search' }],
      responseFormat,
      signal: ctx.abortSignal,
    });

    // xAI guarantees schema match for supported features. A zod parse
    // failure here = our schema uses an unsupported keyword (programming
    // bug, not runtime variance). Throw with a clear prefix.
    const parsed = xaiFindCustomersResponseSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(
        `schema-construction-bug: xAI output failed zod validation: ${parsed.error.message}`,
      );
    }

    log.info(
      `xai_find_customers (${modeLabel}, model=${model}): ${parsed.data.tweets.length} tweets · ` +
        `tokens in/out=${result.usage.inputTokens}/${result.usage.outputTokens}`,
    );

    ctx.emitProgress?.(
      'xai_find_customers',
      `Got ${parsed.data.tweets.length} candidate${parsed.data.tweets.length === 1 ? '' : 's'}`,
      {
        candidateCount: parsed.data.tweets.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    );

    return {
      tweets: parsed.data.tweets,
      notes: parsed.data.notes,
      assistantMessage: result.assistantMessage,
      usage: result.usage,
    };
  },
});
