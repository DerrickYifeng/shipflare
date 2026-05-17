import { z } from "zod";
import type { RedditMcpAgent } from "../RedditMcpAgent";

/**
 * reddit_search — discover Reddit threads matching the founder's
 * product / intent via Reddit's PUBLIC JSON API.
 *
 * Anonymous: Reddit's `*.json` endpoints accept any non-empty
 * `User-Agent` header without auth. No `getChannel` lookup; tests +
 * dev environments without a connected Reddit channel still exercise
 * this tool's full path.
 *
 * Endpoint shape:
 *   - All-of-Reddit search:   https://www.reddit.com/search.json
 *   - Per-subreddit search:   https://www.reddit.com/r/<sr>/search.json
 *     (also passes `restrict_sr=true` to scope to the subreddit)
 *
 * Output mirrors `x_search`: a JSON array of raw threads
 *   `[{ externalId, author, content }]`
 * where `externalId` is Reddit's post id (NOT the fullname — i.e. the
 * `t3_` prefix is stripped). Downstream callers re-prefix when calling
 * `reddit_post` to reply. `content` is `title + selftext` joined with
 * two newlines so judging downstream sees the full self-post body.
 *
 * Graceful degradation: any non-2xx OR JSON parse failure returns an
 * empty array rather than crashing the caller's sweep — same pattern
 * as `x_search`. Reddit rate-limits anonymous traffic per IP; on 429
 * we silently degrade and the caller's next tick retries.
 *
 * --- 5.1c.M1: pure-async helper extracted ---
 * `redditSearchImpl` is the canonical search function. Both the MCP
 * tool registration AND the `/internal/reddit_search` HTTP route on
 * `RedditMcpAgent` call it directly. No env needed (Reddit's public
 * JSON API is anonymous).
 */

export const redditSearchArgsSchema = z.object({
	product: z.string().min(1),
	productDescription: z.string().optional(),
	intent: z.string().optional(),
	maxResults: z.number().int().min(1).max(100).default(20),
	subreddit: z.string().optional(),
});
export type RedditSearchArgs = z.infer<typeof redditSearchArgsSchema>;

export interface RedditSearchThread {
	externalId: string;
	author: string;
	content: string;
}

export async function redditSearchImpl(
	args: RedditSearchArgs,
): Promise<RedditSearchThread[]> {
	const { product, productDescription, intent, subreddit, maxResults } = args;
	const url = new URL(
		subreddit
			? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json`
			: `https://www.reddit.com/search.json`,
	);
	url.searchParams.set(
		"q",
		buildSearchQuery(product, productDescription, intent),
	);
	url.searchParams.set("limit", String(maxResults));
	// 'new' bias matches xAI date-pinning (project memory 2026-05-06):
	// wide windows re-surface the same threads across sweeps. Sorting
	// by recency keeps each sweep fresh.
	url.searchParams.set("sort", "new");
	url.searchParams.set("restrict_sr", subreddit ? "true" : "false");

	let res: Response;
	try {
		res = await fetch(url.toString(), {
			headers: {
				// Reddit returns 429 (or 403) for anonymous requests with
				// an empty or generic UA. Identifying the client as
				// ShipFlare keeps us inside Reddit's expected envelope.
				"User-Agent": "shipflare-cf/1.0 (https://shipflare.com)",
			},
		});
	} catch (err) {
		console.error("[reddit_search] fetch failed:", err);
		return [];
	}

	if (!res.ok) {
		console.error(
			`[reddit_search] reddit returned ${res.status}: ${await res
				.text()
				.catch(() => "(no body)")}`,
		);
		return [];
	}

	let data: RedditListing<RedditPostData>;
	try {
		data = (await res.json()) as RedditListing<RedditPostData>;
	} catch (err) {
		console.error("[reddit_search] response JSON parse failed:", err);
		return [];
	}

	return (data.data?.children ?? [])
		.map((c) => {
			const d = c?.data;
			if (!d || typeof d.id !== "string") return null;
			const title = typeof d.title === "string" ? d.title : "";
			const body = typeof d.selftext === "string" ? d.selftext : "";
			const content = body ? `${title}\n\n${body}` : title;
			return {
				externalId: d.id,
				author: typeof d.author === "string" ? d.author : "",
				content,
			};
		})
		.filter(
			(t): t is RedditSearchThread =>
				t !== null && t.content.length > 0,
		);
}

export function registerRedditSearchTool(agent: RedditMcpAgent): void {
  agent.server.registerTool(
    "reddit_search",
    {
      description:
        "Search Reddit via the public JSON API. Returns raw threads " +
        "(no judging) as [{externalId, author, content}]. Optional " +
        "subreddit scope; default sort is 'new' for freshness.",
      inputSchema: {
        product: z.string().min(1),
        productDescription: z.string().optional(),
        intent: z.string().optional(),
        maxResults: z.number().int().min(1).max(100).default(20),
        subreddit: z
          .string()
          .optional()
          .describe(
            "If set, restrict the search to this subreddit (no r/ prefix).",
          ),
      },
    },
    async ({ product, productDescription, intent, maxResults, subreddit }) => {
      const threads = await redditSearchImpl({
        product,
        productDescription,
        intent,
        maxResults,
        subreddit,
      });
      return jsonContent(threads);
    },
  );
}

/**
 * Construct a Reddit-friendly search query from the founder's product
 * and the caller's intent hint. Reddit's search uses a Lucene-ish
 * syntax; we keep it simple — `${product} ${intent}` — and let
 * Reddit's relevance ranking do the heavy lifting. ProductDescription
 * is intentionally NOT appended to the q-string because Reddit
 * down-ranks long queries; it's available for future tools that build
 * embedding-based filters.
 */
function buildSearchQuery(
  product: string,
  _productDescription: string | undefined,
  intent: string | undefined,
): string {
  const intentPart = intent && intent !== "engagement" ? ` ${intent}` : "";
  return `${product}${intentPart}`.trim();
}

interface RedditListing<TData> {
  data?: {
    children?: Array<{
      data?: TData;
    }>;
  };
}

interface RedditPostData {
  id: string;
  title: string;
  selftext?: string;
  author?: string;
}

function jsonContent(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
