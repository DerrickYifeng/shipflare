import type { ZodTypeAny, z } from "zod";

/**
 * Shared scaffolding for `/internal/*` JSON POST routes on platform/MCP/CMO
 * Durable Objects.
 *
 * Each new internal JSON route is a thin shell: parse a JSON body, validate
 * it with a Zod schema, call an impl, return the result as JSON. This helper
 * unifies the boilerplate so adding a new route is a few lines, and the
 * error-handling shape stays consistent across the codebase.
 *
 * Response contract:
 *   - 400 `{ error: "invalid json body: ..." }`  — body is not valid JSON
 *   - 400 `{ error: "invalid body: ..." }`       — body fails Zod validation
 *   - 500 `{ error: "..." }`                     — impl threw
 *   - 200 `<JSON.stringify(result)>`             — happy path
 *
 * All non-2xx responses set `content-type: application/json` so callers can
 * `await res.json()` uniformly.
 *
 * Callers are responsible for the `x-shipflare-internal: 1` gate — this
 * helper trusts the request has already cleared that check. (The gate sits
 * BEFORE the path branches in each DO's `fetch()` method.)
 */
export async function handleInternalJson<TSchema extends ZodTypeAny, TResult>(
	request: Request,
	label: string,
	bodySchema: TSchema,
	impl: (body: z.infer<TSchema>) => Promise<TResult>,
): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${label}] body parse failed:`, msg);
		return new Response(
			JSON.stringify({ error: `invalid json body: ${msg}` }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	let body: z.infer<TSchema>;
	try {
		body = bodySchema.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${label}] body validation failed:`, msg);
		return new Response(
			JSON.stringify({ error: `invalid body: ${msg}` }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	try {
		const result = await impl(body);
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${label}] failed:`, msg);
		return new Response(JSON.stringify({ error: msg }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}
}
