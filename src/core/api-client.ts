import Anthropic from '@anthropic-ai/sdk';
import type { ModelCosts, UsageSummary } from './types';
import { MODEL_PRICING } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('core:api');

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Retry logic (ported from engine/services/api/withRetry.ts)
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const MAX_RETRIES = 3;

/**
 * Exponential backoff with jitter.
 * Ported from engine/services/api/withRetry.ts:530-548.
 */
function getRetryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

/**
 * Whether an API error is retryable.
 * Ported from engine/services/api/withRetry.ts error classification.
 */
function isRetryableError(error: unknown): { retryable: boolean; retryAfter?: string | null } {
  if (error instanceof Anthropic.APIError) {
    // 529 overloaded
    if (error.status === 529) {
      return { retryable: true, retryAfter: (error.headers as Record<string, string>)?.['retry-after'] };
    }
    // 429 rate limit
    if (error.status === 429) {
      return { retryable: true, retryAfter: (error.headers as Record<string, string>)?.['retry-after'] };
    }
    // 500/502/503 server errors
    if (error.status >= 500 && error.status < 600) {
      return { retryable: true };
    }
    // 413 prompt too long — caller handles this
    // 400/401/403/404 — not retryable
    return { retryable: false };
  }

  // Connection errors
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('econnreset') || msg.includes('epipe') || msg.includes('ssl') || msg.includes('tls')) {
      return { retryable: true };
    }
  }

  return { retryable: false };
}

// ---------------------------------------------------------------------------
// Streaming API call with retry + prompt caching
// ---------------------------------------------------------------------------

export interface CreateMessageOptions {
  model: string;
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools?: Anthropic.Messages.Tool[];
  maxTokens?: number;
  /** Enable prompt caching on system prompt + tools. Default: true. */
  promptCaching?: boolean;
  /** Structured output schema for guaranteed JSON. */
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * Pre-built system prompt blocks. When provided, overrides `system` string.
   * Used by cache-safe forking to ensure byte-identical system blocks
   * across parallel agents.
   */
  systemBlocks?: Anthropic.Messages.TextBlockParam[];
}

export interface CreateMessageResult {
  response: Anthropic.Messages.Message;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/**
 * Create a message with retry logic and prompt caching.
 * Ported from engine/services/api/claude.ts + withRetry.ts.
 *
 * Uses non-streaming API for simplicity (headless agents don't need
 * real-time token streaming). Retries on transient errors.
 */
export async function createMessage(opts: CreateMessageOptions): Promise<CreateMessageResult> {
  const {
    model,
    messages,
    tools,
    maxTokens = 8192,
    promptCaching = true,
    outputSchema,
    signal,
  } = opts;

  // Build system prompt with cache control (use pre-built blocks when provided)
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = opts.systemBlocks ?? [
    {
      type: 'text' as const,
      text: opts.system,
      ...(promptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
    },
  ];

  // Build tools with cache control on the last tool (Anthropic caches from the breakpoint).
  // When systemBlocks is provided (cache-safe path), tools are already pre-cached by caller.
  let cachedTools: Anthropic.Messages.Tool[] | undefined;
  if (tools && tools.length > 0 && !opts.systemBlocks) {
    cachedTools = tools.map((tool, i) => {
      if (promptCaching && i === tools.length - 1) {
        return { ...tool, cache_control: { type: 'ephemeral' as const } };
      }
      return tool;
    });
  } else {
    cachedTools = tools;
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    try {
      const response = await getClient().messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemBlocks,
          messages,
          ...(cachedTools ? { tools: cachedTools } : {}),
          ...(outputSchema ? { output_format: { type: 'json_schema', json_schema: outputSchema } } : {}),
        },
        { signal },
      );

      const rawUsage = response.usage as unknown as Record<string, number>;
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: rawUsage.cache_creation_input_tokens ?? 0,
      };

      return { response, usage };
    } catch (error) {
      lastError = error;

      // Check if this is a max_output_tokens that needs escalation
      if (error instanceof Anthropic.APIError && error.status === 400) {
        const msg = (error.message ?? '').toLowerCase();
        if (msg.includes('prompt is too long') || msg.includes('prompt_too_long')) {
          // Not retryable via backoff — caller must handle context reduction
          throw error;
        }
      }

      const { retryable, retryAfter } = isRetryableError(error);
      if (!retryable || attempt === MAX_RETRIES) {
        throw error;
      }

      const delay = getRetryDelay(attempt, retryAfter);
      log.warn(`API retry ${attempt}/${MAX_RETRIES} for ${model} after ${delay.toFixed(0)}ms`);
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Cache-safe block builders (ported from engine/services/api/claude.ts)
// ---------------------------------------------------------------------------

/**
 * Build system blocks and tool array with cache_control markers from shared
 * params. The returned objects are meant to be reused across parallel
 * createMessage() calls so the Anthropic cache key matches byte-for-byte.
 *
 * Cache breakpoint placement (matching engine/services/api/claude.ts):
 * - System prompt: cache_control on last block
 * - Tools: cache_control on last tool
 */
export function buildCacheSafeBlocks(params: {
  systemPrompt: string;
  tools: Anthropic.Messages.Tool[];
}): {
  systemBlocks: Anthropic.Messages.TextBlockParam[];
  cachedTools: Anthropic.Messages.Tool[] | undefined;
} {
  const { systemPrompt, tools } = params;

  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text' as const,
      text: systemPrompt,
      cache_control: { type: 'ephemeral' as const },
    },
  ];

  let cachedTools: Anthropic.Messages.Tool[] | undefined;
  if (tools.length > 0) {
    cachedTools = tools.map((tool, i) =>
      i === tools.length - 1
        ? { ...tool, cache_control: { type: 'ephemeral' as const } }
        : tool,
    );
  }

  return { systemBlocks, cachedTools };
}

/**
 * Add cache_control breakpoint to the last message in a message array.
 * Returns a shallow clone — does not mutate the input (important when
 * the prefix is shared across agents).
 *
 * Converts string content to block format when needed.
 * Matches engine/services/api/claude.ts addCacheBreakpoints behavior.
 */
export function addMessageCacheBreakpoint(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  if (messages.length === 0) return messages;

  const result = [...messages];
  const lastIdx = result.length - 1;
  const lastMsg = result[lastIdx]!;

  if (typeof lastMsg.content === 'string') {
    result[lastIdx] = {
      ...lastMsg,
      content: [
        {
          type: 'text' as const,
          text: lastMsg.content,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
    };
  } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
    const blocks = [...lastMsg.content];
    const lastBlock = blocks[blocks.length - 1]!;
    blocks[blocks.length - 1] = {
      ...lastBlock,
      cache_control: { type: 'ephemeral' as const },
    } as typeof lastBlock;
    result[lastIdx] = { ...lastMsg, content: blocks };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Side query (ported from engine/utils/sideQuery.ts)
// ---------------------------------------------------------------------------

export interface SideQueryOptions {
  model: string;
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools?: Anthropic.Messages.Tool[];
  outputSchema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Lightweight parallel API call for non-primary queries.
 * Used for memory retrieval, tool use summaries, etc.
 * Ported from engine/utils/sideQuery.ts.
 */
export async function sideQuery(opts: SideQueryOptions): Promise<Anthropic.Messages.Message> {
  const { response } = await createMessage({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxTokens: opts.maxTokens ?? 1024,
    outputSchema: opts.outputSchema,
    signal: opts.signal,
    promptCaching: false, // Side queries are short-lived, caching not beneficial
  });
  return response;
}

// ---------------------------------------------------------------------------
// Usage tracker (ported from engine/cost-tracker.ts)
// ---------------------------------------------------------------------------

/**
 * Calculate USD cost from token usage.
 * Ported from engine/utils/modelCost.ts:tokensToUSDCost.
 */
export function calculateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const costs = MODEL_PRICING[model];
  if (!costs) {
    // Fallback to Sonnet pricing for unknown models
    const fallback = MODEL_PRICING['claude-sonnet-4-6']!;
    return tokensToUsd(fallback, usage);
  }
  return tokensToUsd(costs, usage);
}

function tokensToUsd(
  costs: ModelCosts,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  return (
    (usage.inputTokens / 1_000_000) * costs.inputTokens +
    (usage.outputTokens / 1_000_000) * costs.outputTokens +
    (usage.cacheReadTokens / 1_000_000) * costs.promptCacheReadTokens +
    (usage.cacheWriteTokens / 1_000_000) * costs.promptCacheWriteTokens
  );
}

/**
 * Mutable usage tracker for aggregating cost across multiple API calls.
 * Ported from engine/cost-tracker.ts session-level aggregation.
 */
export class UsageTracker {
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _cacheReadTokens = 0;
  private _cacheWriteTokens = 0;
  private _model = '';
  private _turns = 0;

  add(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, model: string): void {
    this._inputTokens += usage.inputTokens;
    this._outputTokens += usage.outputTokens;
    this._cacheReadTokens += usage.cacheReadTokens;
    this._cacheWriteTokens += usage.cacheWriteTokens;
    this._model = model;
    this._turns += 1;
  }

  toSummary(): UsageSummary {
    return {
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      cacheReadTokens: this._cacheReadTokens,
      cacheWriteTokens: this._cacheWriteTokens,
      costUsd: calculateCost(this._model, {
        inputTokens: this._inputTokens,
        outputTokens: this._outputTokens,
        cacheReadTokens: this._cacheReadTokens,
        cacheWriteTokens: this._cacheWriteTokens,
      }),
      model: this._model,
      turns: this._turns,
    };
  }
}
