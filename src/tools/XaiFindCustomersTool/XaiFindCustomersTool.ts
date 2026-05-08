import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { ToolDefinition } from '@/core/types';
import { XAIClient } from '@/lib/xai-client';
import type { ConversationalMessage } from '@/lib/xai-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:xai_find_customers');

export const XAI_FIND_CUSTOMERS_TOOL_NAME = 'xai_find_customers';

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
  /** Default false → fast non-reasoning Grok variant. Caller escalates to
   *  true after weak rounds. */
  reasoning: z.boolean().default(false),
  /**
   * xAI `tools` array. Caller-owned: X discovery passes
   * `[{ type: 'x_search' }]`; Reddit discovery passes a `web_search`
   * tool with a reddit.com domain filter. We do not validate the shape
   * — xAI's API surface defines what is accepted.
   */
  tools: z.array(z.unknown()).min(1),
  /**
   * JSON schema literal for `response_format.json_schema.schema`, in
   * xAI's strict shape (every property required, nullable as type unions,
   * `additionalProperties: false` on every object). Caller-owned per
   * platform — see `FindThreadsViaXaiTool/schemas.ts` for the X / Reddit
   * pairs (each JSON literal is paired with a Zod mirror the caller uses
   * to safeParse the returned `output`).
   */
  responseFormatSchema: z.unknown().refine((v) => v !== undefined && v !== null, {
    message: 'responseFormatSchema is required',
  }),
  /** Stable JSON schema name xAI sees in the response_format envelope.
   *  Caller-owned per platform (e.g. `tweet_search_result`,
   *  `reddit_thread_search_result`). */
  responseFormatName: z.string().min(1),
});

export interface XaiFindCustomersResult {
  /**
   * Raw parsed JSON from xAI's structured output. `null` when xAI ignored
   * `response_format` and returned prose (see degraded-path branch below).
   * Caller validates against its own Zod schema (the mirror of the JSON
   * literal it passed in `responseFormatSchema`).
   */
  output: unknown;
  /**
   * String pulled from the parsed output's top-level `notes` field when
   * present (both shipped schemas use that field name). Empty when the
   * output has no `notes`. On the degraded path this is the raw prose
   * Grok returned, truncated to 1000 chars.
   */
  notes: string;
  assistantMessage: ConversationalMessage;
  /** Token usage so the caller / observability layer can report. */
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

/**
 * Walk a parsed JSON object, return the length of the first array-typed
 * value found. Used to detect the prose-vs-structured Grok hallucination
 * pattern: `notes` claims matches were found but every array property is
 * empty. Returns 0 when no array property exists.
 */
function firstArrayLength(output: unknown): number {
  if (!output || typeof output !== 'object') return 0;
  for (const v of Object.values(output as Record<string, unknown>)) {
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

const FOUND_PROSE_RE = /\b(found|matches|strong|relevant|spotted|surfaced)\b/i;

export const xaiFindCustomersTool = buildTool({
  name: XAI_FIND_CUSTOMERS_TOOL_NAME,
  description:
    'Conversational xAI Grok search with caller-owned structured-output ' +
    'schema. Pass the FULL prior xAI message history each call (you own ' +
    'the conversation state — append the previous assistant reply before ' +
    'sending your next refinement). The caller supplies `tools` (xAI ' +
    "search tool config — `x_search` for X, `web_search` filtered to " +
    'reddit.com for Reddit), `responseFormatSchema` (JSON schema literal ' +
    'in xAI strict shape), and `responseFormatName`. Returns the raw ' +
    'parsed JSON in `output` for caller-side Zod validation. Set ' +
    '`reasoning: true` to escalate to the reasoning-enabled Grok model ' +
    '(2-5x cost, deeper analysis).',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: true,
  async execute(input, ctx): Promise<XaiFindCustomersResult> {
    const model = resolveModel(input.reasoning ?? false);
    const modeLabel = (input.reasoning ?? false) ? 'reasoning' : 'fast';
    const formatName = input.responseFormatName;

    ctx.emitProgress?.(
      'xai_find_customers',
      `Asking Grok (${modeLabel}) for matches…`,
      { model, reasoning: input.reasoning, messageCount: input.messages.length },
    );

    const callTools = input.tools as Array<Record<string, unknown>>;

    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: formatName,
        schema: input.responseFormatSchema as object,
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
    // sentence like "No strong matches found." instead of returning the
    // expected JSON envelope. Surface the prose as `notes` so the caller
    // can still reason about it.
    if (result.output === null) {
      log.warn(
        `xai_find_customers (${modeLabel}, schema=${formatName}): xAI returned non-JSON; ` +
          `surfacing prose as notes. parseError=${result.parseError ?? 'unknown'}`,
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
        output: null,
        notes: result.assistantMessage.content.slice(0, 1000),
        assistantMessage: result.assistantMessage,
        usage: result.usage,
      };
    }

    const rawOutput = result.output;
    const extractedNotes =
      typeof rawOutput === 'object' &&
      rawOutput !== null &&
      typeof (rawOutput as Record<string, unknown>).notes === 'string'
        ? ((rawOutput as Record<string, unknown>).notes as string)
        : '';
    const candidateCount = firstArrayLength(rawOutput);

    // Hallucination guard: Grok occasionally narrates "found 5 matches"
    // in `notes` while the structured array is empty. Surface this loudly
    // so callers (and observers reading the agent transcript) don't
    // assume the judging / persistence layer dropped them.
    if (candidateCount === 0 && FOUND_PROSE_RE.test(extractedNotes)) {
      log.warn(
        `xai_find_customers (${modeLabel}, schema=${formatName}): notes claims ` +
          `matches but structured output array is empty — Grok prose hallucination. ` +
          `notes="${extractedNotes.slice(0, 200)}"`,
      );
    }

    log.info(
      `xai_find_customers (${modeLabel}, model=${model}, schema=${formatName}): ` +
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
      output: rawOutput,
      notes: extractedNotes,
      assistantMessage: result.assistantMessage,
      usage: result.usage,
    };
  },
});
