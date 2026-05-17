import { z } from "zod";
import type { XMcpAgent } from "../XMcpAgent";
import type { Env } from "../../../../index";

/**
 * x_search — discover X/Twitter threads via xAI Grok's live search.
 *
 * Called by SMM's `find_threads_via_xai` (and any peer that dials X_MCP).
 * Returns a JSON array of raw threads `[{ externalId, author, content }]`;
 * downstream judging happens in the caller. No OAuth token needed —
 * xAI is keyed via `env.XAI_API_KEY` and Grok performs the X read on the
 * server side.
 *
 * Date scoping: per project memory (2026-05-06), wide windows re-surface
 * the same threads across sweeps. We pin `from_date` to today (UTC) so
 * each sweep sees fresh material. Callers wanting historical search can
 * be wired with a `fromDate` input later — Phase 1 prioritises freshness.
 *
 * Graceful degradation: when `XAI_API_KEY` is unset OR Grok returns
 * unparseable output, we surface an empty array rather than crashing
 * the caller's sweep. The caller logs the empty result and tries again
 * next tick. This matches the existing `find-threads-via-xai.ts`
 * fallback shape.
 *
 * Phase-2 follow-up: lift the system prompt into
 * `packages/skills/searching-x/SKILL.md` once the skill primitive is
 * available in apps/core (currently only the legacy monolith uses it).
 *
 * --- 5.1c.M1: pure-async helper extracted ---
 * `xSearchImpl` is the canonical search function. Both the MCP tool
 * registration AND the `/internal/x_search` HTTP route on `XMcpAgent`
 * call it directly. Peer tools (SMM-side, e.g. `find_threads_via_xai`)
 * can stub-fetch into `env.X_MCP` and get a plain JSON array without
 * going through the MCP envelope.
 */

export const xSearchArgsSchema = z.object({
	product: z.string().min(1),
	productDescription: z.string().optional(),
	intent: z.string().optional(),
	maxResults: z.number().int().min(1).max(50).default(20),
});
export type XSearchArgs = z.infer<typeof xSearchArgsSchema>;

export interface XSearchThread {
	externalId: string;
	author?: string;
	content: string;
}

export async function xSearchImpl(
	env: Env,
	args: XSearchArgs,
): Promise<XSearchThread[]> {
	const { product, productDescription, intent, maxResults } = args;
	const apiKey = env.XAI_API_KEY;
	if (!apiKey) {
		// No key in this environment — return empty rather than crash.
		// Tests + dev setups without an xAI key still exercise the
		// tool-registration + return-shape contract.
		return [];
	}

	const intentResolved = intent ?? "engagement";
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

	const systemPrompt = [
		`You are a search assistant for ${product}.`,
		productDescription ? `Product: ${productDescription}` : "",
		`Find up to ${maxResults} recent X/Twitter threads relevant to ` +
			`"${intentResolved}".`,
		"",
		"Output ONLY a JSON array inside a ```json code block. No prose outside.",
		"Schema (positional):",
		"```json",
		"[",
		'  { "externalId": "<tweet id>", "author": "<author handle>", "content": "<tweet text on one line>" }',
		"]",
		"```",
		"If no relevant threads, output an empty array: []",
	]
		.filter(Boolean)
		.join("\n");

	let response: Response;
	try {
		response = await fetch("https://api.x.ai/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "grok-4-fast",
				messages: [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: `Find threads about: ${product}. Intent: ${intentResolved}.`,
					},
				],
				search_parameters: {
					mode: "on",
					sources: [{ type: "x" }],
					max_search_results: maxResults,
					from_date: today,
				},
			}),
		});
	} catch (err) {
		console.error("[x_search] fetch failed:", err);
		return [];
	}

	if (!response.ok) {
		console.error(
			`[x_search] xAI returned ${response.status}: ${await response
				.text()
				.catch(() => "(no body)")}`,
		);
		return [];
	}

	let data: XAiChatCompletionResponse;
	try {
		data = (await response.json()) as XAiChatCompletionResponse;
	} catch (err) {
		console.error("[x_search] response JSON parse failed:", err);
		return [];
	}

	const text = data.choices?.[0]?.message?.content ?? "";
	return parseThreads(text);
}

export function registerXSearchTool(agent: XMcpAgent): void {
  agent.server.registerTool(
    "x_search",
    {
      description:
        "Search X/Twitter via xAI Grok server-side x_search. Returns " +
        "raw threads (no judging). Scoped to today's date for freshness.",
      inputSchema: {
        product: z.string().min(1),
        productDescription: z.string().optional(),
        intent: z.string().optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ product, productDescription, intent, maxResults }) => {
      const threads = await xSearchImpl(agent.bindings, {
        product,
        productDescription,
        intent,
        maxResults,
      });
      return jsonContent(threads);
    },
  );
}

interface XAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * Parse Grok's response into a structured thread array. Looks for a
 * fenced ```json block first, falls back to a raw JSON array, returns
 * [] on parse failure.
 */
function parseThreads(text: string): XSearchThread[] {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is Record<string, unknown> =>
          typeof t === "object" && t !== null,
      )
      .map((t) => ({
        externalId:
          typeof t.externalId === "string" ? t.externalId : String(t.externalId ?? ""),
        author: typeof t.author === "string" ? t.author : undefined,
        content: typeof t.content === "string" ? t.content : "",
      }))
      .filter((t) => t.externalId && t.content);
  } catch {
    return [];
  }
}

function jsonContent(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
