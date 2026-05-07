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
  /**
   * Optional override for xAI's `tools` array. Defaults to
   * `[{ type: 'x_search' }]` (the original X/Twitter discovery
   * behavior). Reddit discovery passes a `web_search` tool with a
   * reddit.com domain filter. Caller-supplied; we do not validate the
   * shape — xAI's API surface defines what is accepted.
   */
  tools: z.array(z.unknown()).optional(),
  /**
   * Optional override for the structured-output JSON schema. Defaults
   * to the X-tweet schema (derived from `xaiFindCustomersResponseSchema`
   * via `toXaiJsonSchema`). When supplied alongside
   * `responseFormatName`, the tool skips Zod validation against the
   * X-tweet shape and returns the raw parsed JSON in `output` so the
   * caller can validate against its own schema.
   */
  responseFormatSchema: z.unknown().optional(),
  /** Stable JSON schema name xAI sees in the response_format envelope.
   *  Defaults to `'CustomerTweets'` (X path). Required when caller
   *  supplies `responseFormatSchema`. */
  responseFormatName: z.string().optional(),
});

export interface XaiFindCustomersResult {
  /**
   * Parsed `tweets` array — populated only on the default (X) path
   * where the response was Zod-validated against the X-tweet schema.
   * Empty when caller passed a custom `responseFormatSchema`.
   */
  tweets: TweetCandidate[];
  notes: string;
  /**
   * Raw parsed JSON output from xAI. Always populated when xAI
   * honored `response_format` (i.e. not a degraded prose response).
   * Caller validates against its own schema when using a custom
   * `responseFormatSchema`.
   */
  output: unknown;
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
    'output. Pass the FULL prior xAI message history each call (you own ' +
    'the conversation state — append the previous assistant reply before ' +
    'sending your next refinement). Returns tweets matching the product ' +
    'ICP with engagement stats + author bios. Set `reasoning: true` to ' +
    'escalate to the reasoning-enabled Grok model after weak initial ' +
    'rounds (2-5x cost, deeper analysis). ' +
    '\n\n' +
    'INPUT SHAPE (literal — `messages` MUST be an array of objects, NOT a string):\n' +
    '{\n' +
    '  "messages": [\n' +
    '    { "role": "user", "content": "Find tweets where indie founders ..." }\n' +
    '  ],\n' +
    '  "productContext": { "name": "...", "description": "...", "valueProp": "...", "targetAudience": "...", "keywords": ["..."] },\n' +
    '  "reasoning": false\n' +
    '}\n\n' +
    'On the SECOND call, append the prior assistant turn:\n' +
    '{\n' +
    '  "messages": [\n' +
    '    { "role": "user", "content": "<your first prompt>" },\n' +
    '    { "role": "assistant", "content": "<verbatim assistantMessage.content from the previous tool result>" },\n' +
    '    { "role": "user", "content": "<your refinement, e.g. \'drop bot accounts, focus on <500 followers\'>" }\n' +
    '  ],\n' +
    '  "productContext": { ...same as before... },\n' +
    '  "reasoning": false\n' +
    '}',
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

    // Caller can override the search tool (X uses `x_search`; Reddit
    // uses `web_search` with a reddit.com filter) and the JSON schema
    // (X uses the tweet shape; Reddit uses the thread shape). When NOT
    // overridden we keep the original X behavior so existing call
    // sites are unchanged.
    const callTools: Array<Record<string, unknown>> =
      input.tools && input.tools.length > 0
        ? (input.tools as Array<Record<string, unknown>>)
        : [{ type: 'x_search' }];

    const usingCustomSchema =
      input.responseFormatSchema !== undefined &&
      input.responseFormatSchema !== null;
    const schemaForFormat = usingCustomSchema
      ? (input.responseFormatSchema as object)
      : toXaiJsonSchema(xaiFindCustomersResponseSchema);
    const formatName = usingCustomSchema
      ? input.responseFormatName ?? RESPONSE_FORMAT_NAME
      : RESPONSE_FORMAT_NAME;

    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: formatName,
        schema: schemaForFormat,
        strict: true,
      },
    };

    const result = await getClient().respondConversational({
      model,
      messages: input.messages,
      tools: callTools,
      responseFormat,
      signal: ctx.abortSignal,
    });

    // Degraded path: Grok ignored response_format and returned prose.
    // Empirically common when search finds nothing — Grok writes a
    // sentence like "No strong matches found." instead of returning
    // `{ tweets: [], notes: ... }` (or `{ threads: [], ... }`).
    // Synthesize the equivalent so the agent still has a structured
    // response to reason about.
    if (result.output === null) {
      log.warn(
        `xai_find_customers (${modeLabel}): xAI returned non-JSON; ` +
          `synthesizing empty result + prose-as-notes. parseError=${result.parseError ?? 'unknown'}`,
      );
      ctx.emitProgress?.(
        'xai_find_customers',
        `Got 0 candidates (Grok returned prose, not JSON)`,
        {
          candidateCount: 0,
          degraded: true,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      );
      return {
        tweets: [],
        notes: result.assistantMessage.content.slice(0, 1000),
        output: null,
        assistantMessage: result.assistantMessage,
        usage: result.usage,
      };
    }

    // Custom-schema path: caller (e.g. Reddit discovery) passed its own
    // JSON schema. We don't know the shape so we skip the X-Zod check
    // and surface the raw parsed JSON via `output`. The caller is
    // responsible for downstream validation. We still try to extract a
    // string `notes` field (both schemas use `notes`) for a friendlier
    // result envelope.
    if (usingCustomSchema) {
      const rawOutput = result.output as Record<string, unknown> | unknown;
      const candidateCount =
        rawOutput && typeof rawOutput === 'object' && rawOutput !== null
          ? Object.entries(rawOutput).reduce<number>((acc, [, v]) => {
              if (Array.isArray(v) && acc === 0) return v.length;
              return acc;
            }, 0)
          : 0;
      const extractedNotes =
        rawOutput &&
        typeof rawOutput === 'object' &&
        rawOutput !== null &&
        typeof (rawOutput as Record<string, unknown>).notes === 'string'
          ? ((rawOutput as Record<string, unknown>).notes as string)
          : '';

      log.info(
        `xai_find_customers (${modeLabel}, model=${model}, custom-schema=${formatName}): ` +
          `${candidateCount} candidates · ` +
          `tokens in/out=${result.usage.inputTokens}/${result.usage.outputTokens}`,
      );

      ctx.emitProgress?.(
        'xai_find_customers',
        `Got ${candidateCount} candidate${candidateCount === 1 ? '' : 's'}`,
        {
          candidateCount,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      );

      return {
        tweets: [],
        notes: extractedNotes,
        output: rawOutput,
        assistantMessage: result.assistantMessage,
        usage: result.usage,
      };
    }

    // Strict path: xAI honored response_format and we got JSON. Validate
    // against the zod schema; a failure here means a real schema-shape
    // mismatch (e.g. xAI returned `{ tweets: [...] }` but a tweet is
    // missing a required field). Throw — the agent can retry.
    const parsed = xaiFindCustomersResponseSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(
        `xai_find_customers: parsed JSON failed schema validation: ${parsed.error.message}`,
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
      output: result.output,
      assistantMessage: result.assistantMessage,
      usage: result.usage,
    };
  },
});
