import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
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
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  STRUCTURED_OUTPUT_CORRECTION,
  buildStructuredOutputApiTool,
  getMaxStructuredOutputRetries,
  validateStructuredOutput,
} from '@/tools/StructuredOutputTool/StructuredOutputTool';

const log = createLogger('core:agent');

// Phase C Day 3 — the JSON-schema sanitizer that converted Zod schemas
// into Anthropic's structured-outputs grammar was retired. StructuredOutput
// enforcement now runs via the synthesized `StructuredOutput` tool (see
// src/tools/StructuredOutputTool/StructuredOutputTool.ts), which is
// already wired through runAgent below. The sanitizer path was exercised
// only when the agent had NO other tools — a condition the v2 planner
// skills used and the v3 AgentTool.md files never hit. See
// docs/phase-c-audit.md §Day 3.

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

    const { response, usage } = await createMessage({
      model,
      system: systemPrompt,
      messages: conversationMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      maxTokens: currentMaxTokens,
      promptCaching,
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
 *
 * StructuredOutput enforcement:
 *   When `outputSchema` is provided AND the caller is not on the cache-safe
 *   fan-out path (`prebuilt` unset), we synthesize a `StructuredOutput` API
 *   tool (see src/tools/StructuredOutputTool/StructuredOutputTool.ts) with
 *   the caller's Zod schema as its input_schema. The agent MUST call this
 *   tool once to deliver its final answer; runAgent intercepts the tool_use,
 *   Zod-validates, and returns the validated value.
 *
 *   If the agent ends its turn WITHOUT calling StructuredOutput, we inject a
 *   correction message and continue. The retry is bounded by
 *   `MAX_STRUCTURED_OUTPUT_RETRIES` (env var; default 5).
 *
 *   Ported from engine/tools/SyntheticOutputTool + hooks/hookHelpers.ts
 *   registerStructuredOutputEnforcement — the hook system itself is NOT
 *   ported; the Stop-check is inlined here (spec §5.1 row `hookHelpers.ts`).
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
  /**
   * Fine-grained stream events from the agent's tool execution (tool_start /
   * tool_done). Used by the team-run worker to mirror tool calls into
   * `team_messages` for SSE consumers. Undefined in the CLI / test paths
   * where tool-level observability isn't needed.
   */
  onEvent?: (event: import('./types').StreamEvent) => void | Promise<void>,
  /**
   * Called at the top of every turn to drain any user messages that have
   * been queued for mid-run injection (Phase D Day 3: `/api/team/message`
   * pushes into a Redis channel; the team-run worker's subscriber fills a
   * FIFO; this callback drains it). Returned messages are appended to the
   * conversation before the next `createMessage` call so the coordinator
   * reads them on its next turn.
   *
   * Only the top-level coordinator receives this — child subagents spawned
   * via Task don't, so injected messages don't silently leak into
   * specialists' contexts. Messages arriving mid-turn queue until the
   * next turn boundary.
   */
  injectMessages?: () => Anthropic.Messages.MessageParam[],
): Promise<AgentResult<T>> {
  log.debug(`Agent "${config.name}" starting (model=${config.model}, maxTurns=${config.maxTurns})`);

  const baseAnthropicTools = prebuilt?.cachedTools ?? config.tools.map(toAnthropicTool);

  // StructuredOutput mode: when an outputSchema is provided AND we're not on
  // the cache-safe fan-out path (which requires byte-identical tool arrays
  // across children — a schema-specific synthesized tool would bust the
  // shared prefix), append the synthesized tool to the Anthropic tool list.
  // The enforcement/validation happens below inside the turn loop.
  const useStructuredOutput = Boolean(outputSchema) && !prebuilt;
  const structuredOutputApiTool = useStructuredOutput && outputSchema
    ? buildStructuredOutputApiTool(outputSchema)
    : null;

  const anthropicTools = structuredOutputApiTool
    ? [...baseAnthropicTools, structuredOutputApiTool]
    : baseAnthropicTools;

  if (structuredOutputApiTool) {
    log.debug(
      `Agent "${config.name}" using StructuredOutput tool (name=${STRUCTURED_OUTPUT_TOOL_NAME})`,
    );
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    ...(prebuilt?.forkContextMessages ?? []),
    { role: 'user', content: userMessage },
  ];

  const tracker = new UsageTracker();
  let currentMaxTokens = 16_384;

  // StructuredOutput Stop-check retry counter. Only incremented when the
  // agent ends its turn without calling the tool; independent of max_tokens
  // or JSON-fallback retries.
  const maxStructuredRetries = getMaxStructuredOutputRetries();
  let structuredOutputRetries = 0;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    if (context.abortSignal.aborted) {
      throw new Error('Agent execution aborted');
    }

    // Drain any live-injected user messages before we construct the
    // next API payload. Injected messages arrive via Redis pub/sub from
    // `/api/team/message` while this coordinator is mid-run (Phase D
    // Day 3). They're appended as plain user-role messages so Claude
    // sees them like any other prompt turn. Safe to call on turn 1:
    // an empty FIFO returns [] and the loop proceeds normally.
    //
    // IMPORTANT: injected messages can't land on top of an open
    // `tool_use` block — Anthropic's API rejects that shape. When the
    // prior assistant turn ended with tool_use, executeTools (or
    // StructuredOutput intercept) already pushed a tool_result user
    // message before reaching this point, so the conversation tail is
    // always a user or assistant end_turn when we get here.
    if (injectMessages) {
      const pending = injectMessages();
      if (pending.length > 0) {
        messages.push(...pending);
      }
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

      // StructuredOutput intercept: validate the tool's input against the
      // caller's Zod schema and return it as the agent's final output. On
      // validation failure, feed an is_error tool_result back so the model
      // can self-correct on the next turn (same-conversation correction is
      // cheaper than blowing up and re-running the whole agent).
      if (structuredOutputApiTool && outputSchema) {
        const soCall = toolUseBlocks.find(
          (b) => b.name === STRUCTURED_OUTPUT_TOOL_NAME,
        );
        if (soCall) {
          // Observability: surface the synthesized StructuredOutput call on
          // the same event stream regular tools use. Not routed through
          // executeTools (the tool is synthetic), so we emit manually here.
          const structuredOutputStartMs = onEvent ? Date.now() : 0;
          if (onEvent) {
            void Promise.resolve(
              onEvent({
                type: 'tool_start',
                toolName: STRUCTURED_OUTPUT_TOOL_NAME,
                toolUseId: soCall.id,
                input: soCall.input,
              }),
            ).catch(() => {});
          }
          const result = validateStructuredOutput(outputSchema, soCall.input);
          if (onEvent) {
            void Promise.resolve(
              onEvent({
                type: 'tool_done',
                toolName: STRUCTURED_OUTPUT_TOOL_NAME,
                toolUseId: soCall.id,
                result: {
                  tool_use_id: soCall.id,
                  content: result.ok
                    ? JSON.stringify(result.value)
                    : result.message,
                  ...(result.ok ? {} : { is_error: true }),
                },
                durationMs: Date.now() - structuredOutputStartMs,
              }),
            ).catch(() => {});
          }
          if (result.ok) {
            if (onProgress && turn > 1) onProgress({ type: 'scoring' });
            return {
              result: result.value as T,
              usage: tracker.toSummary(),
            };
          }
          if (turn < config.maxTurns) {
            log.warn(
              `Agent "${config.name}" StructuredOutput validation failed on turn ${turn}; asking agent to self-correct`,
            );
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: soCall.id,
                  is_error: true,
                  content: result.message,
                },
              ],
            });
            continue;
          }
          throw new Error(
            `Agent ${config.name}: StructuredOutput validation failed after ${turn} turns`,
          );
        }
      }

      // Strip any stray StructuredOutput calls from the real tool execution
      // set — executeTools doesn't know about the synthesized tool and would
      // report it as an error.
      const executableBlocks = structuredOutputApiTool
        ? toolUseBlocks.filter((b) => b.name !== STRUCTURED_OUTPUT_TOOL_NAME)
        : toolUseBlocks;

      // Map StreamEvents to OnProgress for backward compat
      const toolResults = await executeTools(executableBlocks, config.tools, context, (event) => {
        // Team-run observability: forward raw stream events to callers
        // (Phase A Day 4 — worker mirrors these into team_messages).
        if (onEvent) {
          // Fire-and-forget — never let observer latency block the loop.
          void Promise.resolve(onEvent(event)).catch(() => {});
        }
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

    // Stop-check enforcement: agent ended turn without calling
    // StructuredOutput. Inject correction and keep looping until we exhaust
    // the retry budget. Runs BEFORE text extraction so the legacy
    // JSON-in-prose path below is skipped for StructuredOutput agents.
    if (structuredOutputApiTool && outputSchema) {
      if (
        structuredOutputRetries < maxStructuredRetries &&
        turn < config.maxTurns
      ) {
        structuredOutputRetries++;
        log.warn(
          `Agent "${config.name}" ended turn without ${STRUCTURED_OUTPUT_TOOL_NAME} ` +
            `(retry ${structuredOutputRetries}/${maxStructuredRetries})`,
        );
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: STRUCTURED_OUTPUT_CORRECTION,
        });
        continue;
      }
      throw new Error(
        `Agent ${config.name}: failed to produce ${STRUCTURED_OUTPUT_TOOL_NAME} ` +
          `after ${structuredOutputRetries} Stop-check retries`,
      );
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );

    if (!textBlock) {
      throw new Error(`Agent ${config.name}: no text in final response`);
    }

    const summary = tracker.toSummary();

    if (outputSchema) {
      // Legacy text-JSON path — only reached on the cache-safe fan-out branch
      // (prebuilt set) where StructuredOutput isn't used (byte-identical tool
      // arrays are required for cross-agent cache sharing). StructuredOutput
      // agents exit above via the tool_use intercept or the Stop-check throw.
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
