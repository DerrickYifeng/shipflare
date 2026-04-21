import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentConfig,
  AgentResult,
  OnProgress,
  QueryParams,
  ToolContext,
} from './types';
import { createMessage, UsageTracker, addMessageCacheBreakpoint } from './api-client';
import { toAnthropicTool } from './tool-system';
import { executeTools } from './tool-executor';
import { createLogger } from '@/lib/logger';

const log = createLogger('core:agent');

// ---------------------------------------------------------------------------
// Structured-outputs JSON-schema sanitizer
// ---------------------------------------------------------------------------
//
// Anthropic's structured-outputs grammar rejects several JSON-schema
// constructs that zod-to-json-schema happily emits from idiomatic Zod:
//
//   - minItems: N  (N > 1)         ← z.array(...).min(2+)
//   - maxItems                     ← z.array(...).max(N)
//   - minLength / maxLength        ← z.string().min/max
//   - minimum / maximum            ← z.number().min/max
//   - exclusiveMinimum / exclusiveMaximum
//   - multipleOf
//   - pattern (regex)              ← z.string().regex(...)
//   - format: 'uri' | 'email' | etc. ← z.string().url/email
//   - additionalProperties: true   ← objects without z.strictObject
//   - const                        ← z.literal(x) at schema root
//   - enum with > N members (practical limit exists, not documented)
//
// Anthropic DOES support:
//   - type, enum (reasonable cardinality), properties, required, items,
//     oneOf/anyOf/allOf (bounded), $ref (non-recursive), description.
//   - minItems: 0 or 1 only.
//
// Stripping these constraints doesn't loosen our contract — the outer
// Zod schema still post-validates every response, so string length and
// array cardinality rules still fire. We're just giving the API a
// grammar it can actually compile.
const STRIPPED_KEYS = new Set<string>([
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'const',
  'default',
  'examples',
  '$schema',
]);

function sanitizeJsonSchemaForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeJsonSchemaForAnthropic);
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (STRIPPED_KEYS.has(key)) continue;
    // additionalProperties: allow only `false`. Strip `true` + object forms.
    if (key === 'additionalProperties' && value !== false) continue;
    out[key] = sanitizeJsonSchemaForAnthropic(value);
  }
  return out;
}

function zodToSanitizedJsonSchema(
  schema: z.ZodType<unknown>,
): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, {
    target: 'jsonSchema2019-09',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return sanitizeJsonSchemaForAnthropic(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Query loop (ported from engine/query.ts:248-1409, stripped of CLI concerns)
// ---------------------------------------------------------------------------

/**
 * Core query loop: send messages, execute tools, iterate until done.
 * Ported from engine/query.ts main loop. Simplified for headless agents:
 * - No auto-compaction (agents are stateless, 1-10 turns)
 * - No permission system (all tools pre-authorized)
 * - No streaming UI (events emitted via callback)
 * - No stop hooks, tombstone messages, skill discovery
 *
 * Keeps: tool execution loop, error recovery, turn budget, cost tracking,
 * JSON extraction, prompt caching, structured output.
 */
export async function queryLoop<T>(params: QueryParams): Promise<{ output: T; tracker: UsageTracker }> {
  const {
    messages,
    systemPrompt,
    tools,
    model,
    maxTurns,
    maxOutputTokens = 8192,
    outputSchema,
    abortSignal,
    onEvent,
    promptCaching = true,
  } = params;

  const anthropicTools = tools.map(toAnthropicTool);
  const conversationMessages: Anthropic.Messages.MessageParam[] = [...messages];
  const tracker = new UsageTracker();

  // Build a lightweight ToolContext for tool execution
  const toolContext: ToolContext = {
    abortSignal: abortSignal ?? new AbortController().signal,
    get<V>(key: string): V {
      throw new Error(`Dependency "${key}" not available in queryLoop. Use runAgent() with deps.`);
    },
  };

  let currentMaxTokens = maxOutputTokens;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (abortSignal?.aborted) {
      throw new Error('Query loop aborted');
    }

    log.debug(`Turn ${turn}/${maxTurns} starting`);
    onEvent?.({ type: 'turn_start', turn });

    // Hand the API a grammar-compilable JSON schema when we have an
    // expected output shape. Claude's structured-outputs feature forces
    // the generator to emit tokens that validate against this schema —
    // no more JSON-parse errors, missing enum values, or drifted field
    // names. Zod validation below is kept as a belt-and-suspenders check
    // (free; the object is already compliant when this feature is on).
    //
    // zodToJsonSchema can emit constructs Anthropic doesn't support
    // (minLength/maxLength/minItems>1/regex/additionalProperties:true).
    // See docs — the TS SDK doesn't strip these on raw messages.stream()
    // calls, so we rely on Anthropic returning a 400 at schema-compile
    // time if we drift, and fall back to prompt-level JSON parsing.
    let jsonSchemaForOutput: Record<string, unknown> | undefined;
    if (outputSchema && tools.length === 0) {
      // Structured outputs is currently applied only when tools are
      // absent — our agents either run tools (chain-of-thought tool
      // use) or emit terminal JSON. The planner agents are the latter.
      try {
        jsonSchemaForOutput = zodToSanitizedJsonSchema(outputSchema);
      } catch (err) {
        log.warn(
          `zodToJsonSchema failed — falling back to prompt-level validation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const { response, usage } = await createMessage({
      model,
      system: systemPrompt,
      messages: conversationMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      maxTokens: currentMaxTokens,
      promptCaching,
      outputSchema: jsonSchemaForOutput,
      signal: abortSignal,
    });

    tracker.add(usage, model);

    onEvent?.({
      type: 'turn_complete',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });

    log.debug(`Turn ${turn} stop_reason=${response.stop_reason} in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens}`);

    // --- Handle tool_use: execute tools and continue loop ---
    if (response.stop_reason === 'tool_use') {
      conversationMessages.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      log.debug(`Executing ${toolUseBlocks.length} tool(s): ${toolUseBlocks.map((b) => b.name).join(', ')}`);
      const toolResults = await executeTools(toolUseBlocks, tools, toolContext, onEvent);
      conversationMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // --- Handle max_tokens: escalate output budget ---
    // Ported from engine/query.ts error recovery (lines 1062-1183)
    if (response.stop_reason === 'max_tokens' && currentMaxTokens < 64_000) {
      // Escalate: 8k → 16k → 64k
      const escalatedTokens = currentMaxTokens <= 8192 ? 16_384 : 64_000;
      log.warn(`Max tokens hit, escalating ${currentMaxTokens} → ${escalatedTokens}`);
      currentMaxTokens = escalatedTokens;
      onEvent?.({ type: 'error', error: `max_tokens hit, escalating to ${escalatedTokens}`, recoverable: true });

      // Re-append assistant response and a "please continue" user message
      conversationMessages.push({ role: 'assistant', content: response.content });
      conversationMessages.push({ role: 'user', content: 'Please continue where you left off.' });
      continue;
    }

    // --- Handle end_turn: extract and return output ---
    const textBlock = response.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );

    if (!textBlock) {
      throw new Error(`No text in response after ${turn} turns`);
    }

    // Emit text delta for streaming consumers
    onEvent?.({ type: 'text_delta', text: textBlock.text });

    // Parse output
    if (outputSchema) {
      try {
        const jsonStr = extractJson(textBlock.text);
        const parsed = JSON.parse(jsonStr);
        const validated = outputSchema.parse(parsed);
        return { output: validated as T, tracker };
      } catch (parseError) {
        if (turn < maxTurns) {
          conversationMessages.push({ role: 'assistant', content: response.content });
          conversationMessages.push({
            role: 'user',
            content: 'Your response was not valid JSON. Respond with ONLY a raw JSON object, no explanation or markdown. Start with { and end with }.',
          });
          continue;
        }
        throw new Error(
          `Failed to parse JSON output after ${turn} turns: ${(parseError as Error).message}`,
        );
      }
    }

    return { output: textBlock.text as T, tracker };
  }

  throw new Error(`Exceeded max turns (${maxTurns})`);
}

// ---------------------------------------------------------------------------
// runAgent convenience wrapper (replaces bridge/agent-runner.ts)
// ---------------------------------------------------------------------------

/**
 * High-level agent runner. Collects events, returns final result.
 * Drop-in replacement for bridge's runAgent().
 */
export async function runAgent<T>(
  config: AgentConfig,
  userMessage: string,
  context: ToolContext,
  outputSchema?: z.ZodType<T>,
  onProgress?: OnProgress,
  /** Pre-built cache-safe blocks for cross-agent cache sharing. */
  prebuilt?: {
    systemBlocks: Anthropic.Messages.TextBlockParam[];
    cachedTools?: Anthropic.Messages.Tool[];
    forkContextMessages?: Anthropic.Messages.MessageParam[];
  },
  /** Called on every progress signal to reset the idle timeout in the swarm. */
  onIdleReset?: () => void,
): Promise<AgentResult<T>> {
  log.debug(`Agent "${config.name}" starting (model=${config.model}, maxTurns=${config.maxTurns})`);

  const anthropicTools = prebuilt?.cachedTools ?? config.tools.map(toAnthropicTool);
  const messages: Anthropic.Messages.MessageParam[] = [
    ...(prebuilt?.forkContextMessages ?? []),
    { role: 'user', content: userMessage },
  ];

  // Structured outputs: only applied when the agent has no tools. Agents
  // that call tools produce tool_use blocks, not terminal JSON, so the
  // grammar constraint doesn't apply. Agents that emit terminal JSON
  // (planners, classifiers) get their Zod schema compiled to a JSON
  // schema the API grammar-constrains output to.
  let jsonSchemaForOutput: Record<string, unknown> | undefined;
  if (outputSchema && anthropicTools.length === 0) {
    try {
      jsonSchemaForOutput = zodToSanitizedJsonSchema(outputSchema);
    } catch (err) {
      log.warn(
        `zodToJsonSchema failed for agent "${config.name}" — prompt-level fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const tracker = new UsageTracker();
  let currentMaxTokens = 16_384;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    if (context.abortSignal.aborted) {
      throw new Error('Agent execution aborted');
    }

    // When using pre-built blocks, add cache breakpoint on last message
    // so the growing conversation prefix is cached between turns.
    const cachedMessages = prebuilt ? addMessageCacheBreakpoint(messages) : messages;

    const { response, usage } = await createMessage({
      model: config.model,
      system: config.systemPrompt,
      messages: cachedMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      maxTokens: currentMaxTokens,
      promptCaching: true,
      outputSchema: jsonSchemaForOutput,
      signal: context.abortSignal,
      systemBlocks: prebuilt?.systemBlocks,
    });

    // API responded — reset idle timer (agent is making progress)
    onIdleReset?.();
    tracker.add(usage, config.model);

    log.debug(`Agent "${config.name}" turn ${turn}: stop_reason=${response.stop_reason}, blocks=${response.content.map(b => b.type).join(',')}`);

    // --- Handle tool_use ---
    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      // Map StreamEvents to OnProgress for backward compat
      const toolResults = await executeTools(toolUseBlocks, config.tools, context, (event) => {
        if (event.type === 'tool_start') {
          const query = (event.input as Record<string, unknown>)?.query as string | undefined;
          if (onProgress && query) {
            onProgress({ type: 'tool_call_start', query });
          }
        }
        if (event.type === 'tool_done' && !event.result.is_error) {
          // Tool completed — reset idle timer
          onIdleReset?.();
          const input = toolUseBlocks.find((b) => b.id === event.toolUseId)?.input;
          const query = (input as Record<string, unknown>)?.query as string | undefined;
          if (onProgress && query) {
            try {
              const parsed = JSON.parse(event.result.content);
              const resultCount = Array.isArray(parsed) ? parsed.length : 0;
              onProgress({ type: 'tool_call_done', query, resultCount });
            } catch {
              onProgress({ type: 'tool_call_done', query, resultCount: 0 });
            }
          }
        }
      });

      // Guard: API edge case where stop_reason=tool_use but no tool blocks
      if (toolResults.length === 0) {
        log.warn(`Agent "${config.name}": stop_reason=tool_use but empty tool results, turn ${turn}`);
        break;
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // --- Handle max_tokens escalation ---
    if (response.stop_reason === 'max_tokens') {
      // If max_tokens hit after emitting complete tool_use blocks,
      // execute them first to avoid orphaned tool_use without tool_result.
      const orphanedToolUse = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      if (orphanedToolUse.length > 0) {
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = await executeTools(orphanedToolUse, config.tools, context);
        onIdleReset?.(); // Tools executed — reset idle timer
        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
        if (currentMaxTokens < 64_000) {
          currentMaxTokens = currentMaxTokens <= 8192 ? 16_384 : 64_000;
        }
        continue;
      }

      if (currentMaxTokens < 64_000) {
        currentMaxTokens = currentMaxTokens <= 8192 ? 16_384 : 64_000;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Please continue where you left off.' });
        continue;
      }
    }

    // --- Handle end_turn ---
    if (onProgress && turn > 1) {
      onProgress({ type: 'scoring' });
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );

    if (!textBlock) {
      throw new Error(`Agent ${config.name}: no text in final response`);
    }

    const summary = tracker.toSummary();

    if (outputSchema) {
      try {
        const jsonStr = extractJson(textBlock.text);
        const parsed = JSON.parse(jsonStr);
        const validated = outputSchema.parse(parsed);

        return {
          result: validated,
          usage: summary,
        };
      } catch (parseError) {
        // LLM returned prose instead of JSON — retry with explicit correction
        if (turn < config.maxTurns) {
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: 'Your response was not valid JSON. Respond with ONLY a raw JSON object, no explanation or markdown. Start with { and end with }.',
          });
          continue;
        }
        throw new Error(
          `Agent ${config.name}: failed to parse JSON output after ${turn} turns: ${(parseError as Error).message}`,
        );
      }
    }

    return {
      result: textBlock.text as T,
      usage: summary,
    };
  }

  throw new Error(`Agent ${config.name}: exceeded max turns (${config.maxTurns})`);
}

// ---------------------------------------------------------------------------
// Create a ToolContext with dependency injection
// ---------------------------------------------------------------------------

/**
 * Create a ToolContext with dependency injection.
 * Kept from bridge/agent-runner.ts for backward compat.
 */
export function createToolContext(
  deps: Record<string, unknown>,
  abortSignal?: AbortSignal,
): ToolContext {
  return {
    abortSignal: abortSignal ?? new AbortController().signal,
    get<T>(key: string): T {
      const value = deps[key];
      if (value === undefined) {
        throw new Error(`Missing dependency: ${key}`);
      }
      return value as T;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON extraction (ported from bridge/agent-runner.ts)
// ---------------------------------------------------------------------------

/**
 * Extract JSON from text that may be wrapped in markdown code blocks
 * or have trailing content after the JSON object.
 * Handles: raw JSON, ```json ... ```, ``` ... ```, JSON with trailing text.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();

  // Try markdown code block first (most reliable — bounded by ```)
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try raw JSON — find the matching closing bracket by counting depth
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const open = trimmed[0]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]!;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          // Found the matching close — return substring up to here
          return trimmed.slice(0, i + 1);
        }
      }
    }

    // Depth never reached 0 — return as-is and let JSON.parse report the error
    return trimmed;
  }

  // Fallback: try to find JSON object/array in the text
  const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  return trimmed;
}
