import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
	streamText,
	createUIMessageStream,
	createUIMessageStreamResponse,
	convertToModelMessages,
	tool,
	type StreamTextOnFinishCallback,
	type ToolSet,
	type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeAgentEvent } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCmoSchema } from "./schema";
import { computeNextDailyAt } from "./scheduling";
import { SYNTHETIC_CRON_PROMPT } from "./cron-prompts";
import { makeConsultTool } from "../lib/consult-tool";
import { loadSystemPrompt } from "../lib/system-prompt";
import {
	sendWebPush,
	type PushPayload,
	type PushSubscriptionRow,
} from "../../lib/web-push";
import { handleInternalJson } from "../../lib/internal-route";
import { mirrorDraftBodySchema } from "../../lib/mirror-draft";
import { strategicPathProposalBodySchema } from "../../lib/strategic-path-proposal";

export interface CMOState {
	currentRunId: string | null;
}

/**
 * Concatenate all `text`-typed parts of a UIMessage into a single string.
 * Returns "" if `parts` is missing or contains no text blocks.
 *
 * Separate from `extractText` in social-media-manager/lib/mcp-result.ts —
 * that one unpacks MCP `{ content: [{ type, text }] }` envelopes; this one
 * walks AI SDK v6 UIMessage `parts: [{ type, text }]`. Same conceptual job,
 * different input shape.
 */
function extractTextFromUIMessage(message: UIMessage): string {
	const parts = message.parts ?? [];
	const texts: string[] = [];
	for (const p of parts) {
		if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
			texts.push((p as { text?: string }).text ?? "");
		}
	}
	return texts.join("");
}

/**
 * CMO — founder-facing orchestrator (AIChatAgent).
 *
 * Post-Phase-5 rewrite: the McpAgent surface is gone. The founder talks to
 * CMO via the chat surface; specialist colleagues (HoG, SMM) are reached
 * through the `consult` tool. CMO is the sole writer for per-team state
 * (plan items, drafts, founder_context, memory) — peers answer questions
 * and CMO commits the decisions.
 *
 * Per spec §2 + §3.4 of the CF-native chat migration design.
 *
 * Tools exposed via `getTools()`:
 *   - consult        — generic peer dispatcher (HoG / SMM)
 *   - 14 shared-state tools that the LLM may invoke during chat to read
 *     and write per-team SQLite (founder_context, plan_items, drafts,
 *     memory, employee_log transcripts).
 *
 * Internal HTTP routes survive (Service-Binding-only, gated on
 * `x-shipflare-internal: 1`):
 *   - /internal/init                    — first-login seed of founder_context
 *   - /internal/peer-dm-shadow          — quiet employee_log append; per
 *                                          CLAUDE.md MUST NOT trigger chat
 *   - /internal/push-subscribe          — web-push subscription persistence
 *   - /internal/destroy                 — account-deletion cleanup
 *   - /internal/commit-strategic-path   — onboarding-wizard direct write
 *   - /internal/mirror-draft            — SMM/HoG shadow-POST when a draft hits status='ready'
 *   - /internal/strategic-path-proposal — HoG shadow-POST when a new strategic-path version is generated
 *   - /internal/trigger-alarm           — test-only seam (5.1c.18): invokes
 *                                          `alarm()` directly so the Playwright
 *                                          smoke can drive a daily-relay turn
 *                                          deterministically without waiting
 *                                          for the scheduled timestamp. Gated
 *                                          on the same `x-shipflare-internal`
 *                                          header as every other /internal/
 *                                          route — Cloudflare strips the
 *                                          header from public-edge traffic,
 *                                          so only sibling Workers / Service
 *                                          Bindings can hit it.
 *
 * The legacy /internal/log-activity route + the activity_events table are
 * deleted in this commit (telemetry routes through Analytics Engine via
 * `writeAgentEvent` instead). The legacy /internal/cron-tick fan-out route
 * was retired in 5.1c.16 — per-user daily relays now run via DO `alarm()`
 * (see `scheduleNextRelay` / `alarm`), so the outer `scheduled()` no
 * longer pokes individual CMOs.
 */
export class CMO extends AIChatAgent<Env, CMOState> {
	initialState: CMOState = { currentRunId: null };

	private _schemaApplied = false;

	/**
	 * Idempotent schema bootstrap. Called from `onChatMessage` + every
	 * internal HTTP route handler. `CREATE TABLE IF NOT EXISTS` makes the
	 * SQL safe to run repeatedly across DO restarts; the in-instance guard
	 * is just a micro-optimisation to skip the bytecode compile on the
	 * second call.
	 */
	private ensureSchema(): void {
		if (this._schemaApplied) return;
		applyCmoSchema(this.ctx.storage.sql);
		this._schemaApplied = true;
	}

	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>,
	): Promise<Response | undefined> {
		this.ensureSchema();
		const runId = crypto.randomUUID();
		this.setState({ ...this.state, currentRunId: runId });
		const t0 = Date.now();
		const messages = await convertToModelMessages(this.messages);
		const system = await loadSystemPrompt("cmo");
		const tools: ToolSet = this.getTools();

		const stream = createUIMessageStream({
			execute: ({ writer }) => {
				const result = streamText({
					model: anthropic("claude-sonnet-4-6"),
					messages,
					system,
					tools,
					experimental_context: {
						writer,
						userId: this.name,
						env: this.env,
					},
					onFinish: (event) => {
						writeAgentEvent(this.env, {
							kind: "agent_run",
							userId: this.name,
							runId,
							blobs: ["CMO", event.finishReason ?? "unknown"],
							doubles: [Date.now() - t0],
						});
						return onFinish(event);
					},
				});
				writer.merge(result.toUIMessageStream());
			},
		});
		return createUIMessageStreamResponse({ stream });
	}

	/**
	 * Build the LLM-facing tool surface: `consult` + 14 shared-state tools.
	 *
	 * `self` is captured in a local so each tool's `execute` closure has a
	 * stable `this`-equivalent. The AI SDK invokes execute with its own
	 * `this`, so referencing the class instance must go through this
	 * captured binding rather than the bare `this` keyword.
	 *
	 * Each shared-state tool preserves the SQL behaviour of the legacy
	 * MCP registrations in `tools/shared-state.ts`; the only changes are
	 * (a) wrapping each fragment in `z.object(...)` and (b) returning
	 * native JS values instead of the MCP `{ content: [{ text }] }`
	 * envelope. SQL strings + parameter ordering are identical.
	 */
	getTools(): ToolSet {
		const self = this;
		return {
			consult: makeConsultTool("cmo"),

			queryFounderContext: tool({
				description:
					"Read the founder_context KV map. Identity-level config the chat needs (productName, voice, etc).",
				inputSchema: z.object({}),
				execute: async () => self._queryFounderContext(),
			}),

			setFounderContext: tool({
				description:
					"Upsert a single founder_context KV pair (e.g. productName, voice).",
				inputSchema: z.object({
					key: z.string().min(1),
					value: z.string(),
				}),
				execute: async ({ key, value }) => {
					self.ensureSchema();
					self.ctx.storage.sql.exec(
						`INSERT INTO founder_context (key, value) VALUES (?, ?)
						 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
						key,
						value,
					);
					if (key === "tz" || key === "relayHourLocal") {
						self.scheduleNextRelayAlarm();
					}
					return { ok: true as const };
				},
			}),

			commitStrategicPath: tool({
				description:
					"Record a new strategic_path version. Auto-increments version. Status starts as 'pending_approval'.",
				inputSchema: z.object({
					theme: z.string().min(1),
					narrative: z.record(z.string(), z.unknown()),
					generatedBy: z.string().min(1),
				}),
				execute: async ({ theme, narrative, generatedBy }) => {
					self.ensureSchema();
					const id = crypto.randomUUID();
					const latest = self.ctx.storage.sql
						.exec<{ v: number }>(
							"SELECT COALESCE(MAX(version), 0) as v FROM strategic_path",
						)
						.one();
					const version = latest.v + 1;
					self.ctx.storage.sql.exec(
						`INSERT INTO strategic_path
						 (id, version, theme, narrative_json, status, generated_at, generated_by)
						 VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
						id,
						version,
						theme,
						JSON.stringify(narrative),
						Date.now(),
						generatedBy,
					);
					return { id, version };
				},
			}),

			addPlanItem: tool({
				description:
					"Create a plan_item ticket. Use this to enqueue concrete sprint work derived from the strategic plan.",
				inputSchema: z.object({
					skill: z.string().min(1),
					channel: z.enum(["x", "reddit"]),
					params: z.record(z.string(), z.unknown()),
					ownerRole: z.string().min(1),
					scheduledFor: z.number().optional(),
				}),
				execute: async ({ skill, channel, params, ownerRole, scheduledFor }) => {
					self.ensureSchema();
					const id = crypto.randomUUID();
					self.ctx.storage.sql.exec(
						`INSERT INTO plan_items
						 (id, skill, channel, params_json, status, owner_role, scheduled_for)
						 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
						id,
						skill,
						channel,
						JSON.stringify(params),
						ownerRole,
						scheduledFor ?? null,
					);
					return { id };
				},
			}),

			queryPlanItems: tool({
				description:
					"List plan_items, optionally filtered by status and owner_role. Defaults to oldest-scheduled first.",
				inputSchema: z.object({
					status: z.string().optional(),
					ownerRole: z.string().optional(),
					limit: z.number().int().positive().max(200).default(50),
				}),
				execute: async (args) => self._queryPlanItems(args),
			}),

			updatePlanItem: tool({
				description:
					"Update a plan_item's status and optional output payload. Use when reporting completion or failure.",
				inputSchema: z.object({
					id: z.string().min(1),
					status: z.enum([
						"pending",
						"in_progress",
						"completed",
						"failed",
						"cancelled",
					]),
					output: z.record(z.string(), z.unknown()).optional(),
				}),
				execute: async ({ id, status, output }) => {
					self.ensureSchema();
					const now = Date.now();
					const result = self.ctx.storage.sql.exec(
						`UPDATE plan_items SET
						   status = ?,
						   output_json = ?,
						   started_at = COALESCE(started_at, CASE WHEN ? = 'in_progress' THEN ? END),
						   completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END
						 WHERE id = ?`,
						status,
						output ? JSON.stringify(output) : null,
						status,
						now,
						status,
						now,
						id,
					);
					if (result.rowsWritten === 0) {
						throw new Error(`plan_item not found: ${id}`);
					}
					return { id, status };
				},
			}),

			cancelPlanItem: tool({
				description:
					"Cancel an in-flight plan_item by id. Flips status to 'cancelled' and stamps completed_at. Throws if already terminal.",
				inputSchema: z.object({
					id: z.string().min(1),
				}),
				execute: async ({ id }) => {
					self.ensureSchema();
					const now = Date.now();
					const existing = self.ctx.storage.sql
						.exec<{ id: string; status: string }>(
							"SELECT id, status FROM plan_items WHERE id = ?",
							id,
						)
						.toArray();
					const row = existing[0];
					if (!row) {
						throw new Error(`plan_item not found: ${id}`);
					}
					if (
						row.status === "completed" ||
						row.status === "failed" ||
						row.status === "cancelled"
					) {
						throw new Error(
							`plan_item ${id} is already terminal (${row.status}); cannot cancel`,
						);
					}
					self.ctx.storage.sql.exec(
						`UPDATE plan_items
						 SET status = 'cancelled', completed_at = ?
						 WHERE id = ?`,
						now,
						id,
					);
					return { id, status: "cancelled" as const };
				},
			}),

			approveDraft: tool({
				description:
					"Approve a draft by its draftId. Marks the approval_queue row decided='approved'.",
				inputSchema: z.object({
					draftId: z.string().min(1),
				}),
				execute: async ({ draftId }) => {
					self.ensureSchema();
					const result = self.ctx.storage.sql.exec(
						`UPDATE approval_queue
						 SET decided_at = ?, decision = 'approved'
						 WHERE draft_id = ?`,
						Date.now(),
						draftId,
					);
					if (result.rowsWritten === 0) {
						throw new Error(`draft not in approval_queue: ${draftId}`);
					}
					return { draftId, decision: "approved" as const };
				},
			}),

			rejectDraft: tool({
				description:
					"Reject a draft by its draftId. Marks the approval_queue row decided='rejected'.",
				inputSchema: z.object({
					draftId: z.string().min(1),
					// reason is parsed but not persisted until approval_queue.reason column lands
					reason: z.string().max(500).optional(),
				}),
				execute: async ({ draftId }) => {
					self.ensureSchema();
					const result = self.ctx.storage.sql.exec(
						`UPDATE approval_queue
						 SET decided_at = ?, decision = 'rejected'
						 WHERE draft_id = ?`,
						Date.now(),
						draftId,
					);
					if (result.rowsWritten === 0) {
						throw new Error(`draft not in approval_queue: ${draftId}`);
					}
					return { draftId, decision: "rejected" as const };
				},
			}),

			queryDrafts: tool({
				description:
					"List drafts (typically pending approval) from the approval_queue table.",
				inputSchema: z.object({
					limit: z.number().int().min(1).max(200).default(50),
				}),
				execute: async (args) => self._queryDrafts(args),
			}),

			rememberThis: tool({
				description:
					"Save a fact / preference to long-term memory. Will be injected into every future conversation. Opt-in; founder confirms via the chat UI.",
				inputSchema: z.object({
					content: z.string().min(1).max(2000),
					sourceConversationId: z.string().optional(),
					sourceMessageTs: z.number().int().optional(),
				}),
				execute: async ({ content, sourceConversationId, sourceMessageTs }) => {
					self.ensureSchema();
					const id = crypto.randomUUID();
					self.ctx.storage.sql.exec(
						`INSERT INTO cross_conversation_memory
						   (id, content, source_conversation_id, source_message_ts, added_at, active)
						 VALUES (?, ?, ?, ?, ?, 1)`,
						id,
						content,
						sourceConversationId ?? null,
						sourceMessageTs ?? null,
						Date.now(),
					);
					return { id, ok: true as const };
				},
			}),

			forgetThis: tool({
				description:
					"Deactivate a memory entry (soft delete; keeps audit trail).",
				inputSchema: z.object({
					id: z.string().min(1),
				}),
				execute: async ({ id }) => {
					self.ensureSchema();
					const result = self.ctx.storage.sql.exec(
						"UPDATE cross_conversation_memory SET active = 0 WHERE id = ?",
						id,
					);
					if (result.rowsWritten === 0) {
						throw new Error(`memory not found: ${id}`);
					}
					return { id, ok: true as const };
				},
			}),

			queryMemory: tool({
				description: "List active long-term memories, newest first.",
				inputSchema: z.object({
					limit: z.number().int().positive().max(100).default(50),
				}),
				execute: async (args) => self._queryMemory(args),
			}),

			queryAgentTranscript: tool({
				description:
					"List recent employee_log entries authored by the given role, newest first. Useful for reviewing what a colleague has been doing.",
				inputSchema: z.object({
					role: z.string().min(1),
					limit: z.number().int().positive().max(200).default(100),
				}),
				execute: async (args) => self._queryAgentTranscript(args),
			}),
		};
	}

	// ──────────────────────────────────────────────────────────────────────
	// @callable RPC surface — read group
	//
	// Each method has an `_impl` companion that the AI-SDK `tool({...})`
	// definitions in `getTools()` also delegate to. One SQL implementation,
	// two entry points: the LLM via `tool()`, the browser via `@callable`.
	//
	// Browser auth: every connection to this DO is JWT-verified by
	// `handleCmoWsRequest` (apps/core/src/index.ts) which enforces
	// claims.name === this.name. No per-method auth check needed.
	// ──────────────────────────────────────────────────────────────────────

	private async _queryFounderContext(): Promise<Record<string, string>> {
		this.ensureSchema();
		const rows = this.ctx.storage.sql
			.exec<{ key: string; value: string }>(
				"SELECT key, value FROM founder_context",
			)
			.toArray();
		return Object.fromEntries(rows.map((r) => [r.key, r.value]));
	}

	@callable()
	async queryFounderContext(): Promise<Record<string, string>> {
		return this._queryFounderContext();
	}

	private async _queryPlanItems(args: {
		status?: string;
		ownerRole?: string;
		limit?: number;
	}): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
		let q =
			"SELECT id, skill, channel, params_json, status, owner_role, scheduled_for, started_at, completed_at FROM plan_items WHERE 1=1";
		const bindings: unknown[] = [];
		if (args.status) {
			q += " AND status = ?";
			bindings.push(args.status);
		}
		if (args.ownerRole) {
			q += " AND owner_role = ?";
			bindings.push(args.ownerRole);
		}
		q +=
			" ORDER BY scheduled_for IS NULL, scheduled_for ASC, plan_version ASC LIMIT ?";
		bindings.push(limit);
		return this.ctx.storage.sql
			.exec(q, ...(bindings as SqlStorageValue[]))
			.toArray();
	}

	@callable()
	async queryPlanItems(
		args: {
			status?: string;
			ownerRole?: string;
			limit?: number;
		} = {},
	): Promise<unknown[]> {
		return this._queryPlanItems(args);
	}

	private async _queryDrafts(args: { limit?: number }): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
		return this.ctx.storage.sql
			.exec(
				`SELECT id, draft_id, employee, kind, channel, preview, created_at, decided_at, decision
				 FROM approval_queue
				 ORDER BY created_at DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryDrafts(args: { limit?: number } = {}): Promise<unknown[]> {
		return this._queryDrafts(args);
	}

	private async _queryMemory(args: { limit?: number }): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
		return this.ctx.storage.sql
			.exec<{
				id: string;
				content: string;
				added_at: number;
				source_conversation_id: string | null;
			}>(
				`SELECT id, content, added_at, source_conversation_id
				 FROM cross_conversation_memory
				 WHERE active = 1
				 ORDER BY added_at DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryMemory(args: { limit?: number } = {}): Promise<unknown[]> {
		return this._queryMemory(args);
	}

	private async _queryAgentTranscript(args: {
		role: string;
		limit?: number;
	}): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
		return this.ctx.storage.sql
			.exec<{
				id: number;
				conversation_id: string | null;
				from_role: string;
				kind: string;
				summary: string | null;
				payload_json: string | null;
				ts: number;
			}>(
				`SELECT id, conversation_id, from_role, kind, summary, payload_json, ts
				 FROM employee_log
				 WHERE from_role = ?
				 ORDER BY ts DESC
				 LIMIT ?`,
				args.role,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryAgentTranscript(args: {
		role: string;
		limit?: number;
	}): Promise<unknown[]> {
		return this._queryAgentTranscript(args);
	}

	/**
	 * Route `/internal/*` HTTP traffic to our private handlers; everything
	 * else falls through to AIChatAgent's own `fetch()` (which handles the
	 * chat WebSocket transport and the agent-tool RPC path).
	 *
	 * All `/internal/*` endpoints are gated on the `x-shipflare-internal: 1`
	 * header. The Worker entry sets this for Service-Binding-initiated
	 * traffic; Cloudflare's network layer rejects forged versions of the
	 * header from public clients. The 403 here is a belt-and-braces check —
	 * only internal CF traffic should ever reach these paths.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const internal = request.headers.get("x-shipflare-internal") === "1";
		if (!internal && url.pathname.startsWith("/internal/")) {
			return new Response("forbidden", { status: 403 });
		}

		// 5.1c.15: lazy TZ bootstrap on first client-facing request.
		// Hits ANY non-/internal/ path (WS upgrade, /health, etc.) — the
		// bootstrap is idempotent (won't overwrite existing tz).
		if (!url.pathname.startsWith("/internal/")) {
			const inferredTz = request.headers.get("x-inferred-tz");
			if (inferredTz) {
				await this.bootstrapTzIfMissing(inferredTz);
			}
		}

		if (url.pathname === "/internal/init") {
			this.ensureSchema();
			return this.handleInit(request);
		}
		if (url.pathname === "/internal/peer-dm-shadow") {
			this.ensureSchema();
			return this.handlePeerShadow(request);
		}
		if (url.pathname === "/internal/push-subscribe") {
			this.ensureSchema();
			return this.handlePushSubscribe(request);
		}
		if (url.pathname === "/internal/destroy") {
			return this.handleDestroy();
		}
		if (url.pathname === "/internal/commit-strategic-path") {
			this.ensureSchema();
			return this.handleCommitStrategicPath(request);
		}
		if (url.pathname === "/internal/mirror-draft") {
			this.ensureSchema();
			return handleInternalJson(
				request,
				"CMO /internal/mirror-draft",
				mirrorDraftBodySchema,
				async (body) => {
					// Idempotent: skip insert if draft_id already present.
					const existing = this.ctx.storage.sql
						.exec<{ id: string }>(
							"SELECT id FROM approval_queue WHERE draft_id = ? LIMIT 1",
							body.draftId,
						)
						.toArray();
					if (existing.length === 0) {
						this.ctx.storage.sql.exec(
							`INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?)`,
							crypto.randomUUID(),
							body.draftId,
							body.employee,
							body.kind,
							body.channel,
							body.preview,
							body.createdAt,
						);
						writeAgentEvent(this.env, {
							kind: "agent_run",
							userId: this.name,
							blobs: ["CMO", "draft-mirrored", body.employee, body.channel, body.kind],
							doubles: [0],
						});
					}

					return { ok: true };
				},
			);
		}
		if (url.pathname === "/internal/trigger-alarm") {
			// 5.1c.18 — test-only seam for the Playwright real-LLM smoke.
			// Drives a daily-relay turn deterministically by invoking
			// `alarm()` directly, instead of waiting on the scheduled
			// `ctx.storage.setAlarm` deadline. The route inherits the
			// `x-shipflare-internal: 1` gate at the top of fetch(), so
			// only sibling Workers / Service Bindings can reach it.
			await this.alarm();
			return new Response("alarm-triggered", { status: 200 });
		}
		if (url.pathname === "/internal/strategic-path-proposal") {
			this.ensureSchema();
			return handleInternalJson(
				request,
				"CMO /internal/strategic-path-proposal",
				strategicPathProposalBodySchema,
				async (body) => {
					// Idempotent on (version, generated_by) — skip insert if already present.
					const existing = this.ctx.storage.sql
						.exec<{ id: string }>(
							"SELECT id FROM strategic_path WHERE version = ? AND generated_by = ? LIMIT 1",
							body.version,
							body.generatedBy,
						)
						.toArray();
					if (existing.length === 0) {
						this.ctx.storage.sql.exec(
							`INSERT INTO strategic_path
								(id, version, theme, narrative_json, status, generated_at, generated_by)
							 VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
							crypto.randomUUID(),
							body.version,
							body.theme,
							body.narrativeJson,
							body.generatedAt,
							body.generatedBy,
						);
						writeAgentEvent(this.env, {
							kind: "agent_run",
							userId: this.name,
							blobs: ["CMO", "strategic-path-proposed", body.generatedBy],
							doubles: [body.version],
						});
					}
					return { ok: true };
				},
			);
		}

		return super.fetch(request);
	}

	/**
	 * Idempotent first-login hook. Called from `apps/web`'s Better Auth
	 * `databaseHooks.user.create.after` after a fresh user row lands in D1.
	 *
	 * Body: `{ email: string, githubLogin: string | null }`
	 *
	 * Effects (once, on first call):
	 *  - Seeds `founder_context` with email + githubLogin.
	 *
	 * Roster seeding was retired in Task 5.1b — `EMPLOYEE_REGISTRY` is now
	 * the static org chart and all peers are always available via the
	 * `consult` tool. The roster table is gone from `applyCmoSchema`.
	 *
	 * Idempotency: subsequent calls return `already_initialized` without
	 * overwriting existing rows. We gate on `founder_context` row count.
	 */
	private async handleInit(request: Request): Promise<Response> {
		const ctxCount = this.ctx.storage.sql
			.exec<{ c: number }>("SELECT COUNT(*) as c FROM founder_context")
			.one().c;
		if (ctxCount > 0) {
			return new Response("already_initialized", { status: 200 });
		}

		const body = (await request.json()) as {
			email: string;
			githubLogin: string | null;
		};

		this.ctx.storage.sql.exec(
			"INSERT INTO founder_context (key, value) VALUES (?, ?)",
			"email",
			body.email,
		);
		if (body.githubLogin) {
			this.ctx.storage.sql.exec(
				"INSERT INTO founder_context (key, value) VALUES (?, ?)",
				"githubLogin",
				body.githubLogin,
			);
		}

		return new Response("initialized", { status: 200 });
	}

	/**
	 * Peer-DM shadow log — Spec §6.1 invariant #2.
	 *
	 * When peer A wants the CMO to know it consulted peer B (e.g. for
	 * audit purposes), it POSTs here. We append to `employee_log` and
	 * return; this handler MUST NOT trigger `onChatMessage`. CMO picks
	 * up shadow rows on its next natural wake.
	 */
	private async handlePeerShadow(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			conversationId?: string;
			fromRole: string;
			toRole: string;
			tool: string;
			summary: string;
			payload?: unknown;
		};
		this.ctx.storage.sql.exec(
			`INSERT INTO employee_log
			   (conversation_id, from_role, kind, summary, payload_json, ts, notified_founder)
			 VALUES (?, ?, 'peer_dm_shadow', ?, ?, ?, 0)`,
			body.conversationId ?? null,
			body.fromRole,
			body.summary,
			JSON.stringify({
				to: body.toRole,
				tool: body.tool,
				payload: body.payload,
			}),
			Date.now(),
		);
		return new Response("logged", { status: 200 });
	}

	/**
	 * Lazy-bootstrap founder_context.tz from the inferred TZ on the WS
	 * upgrade. Only writes if tz is unset — never overwrites a manually-set
	 * value. Also schedules the first relay alarm.
	 *
	 * Called from `fetch()` when an inbound request carries `x-inferred-tz`
	 * (added by 5.1c.14's handleCmoWsRequest in apps/core/src/index.ts).
	 */
	private async bootstrapTzIfMissing(tz: string): Promise<void> {
		this.ensureSchema();
		const existing = this.ctx.storage.sql
			.exec("SELECT value FROM founder_context WHERE key = 'tz'")
			.toArray();
		if (existing.length > 0) return;
		this.ctx.storage.sql.exec(
			"INSERT INTO founder_context (key, value) VALUES (?, ?)",
			"tz", tz,
		);
		this.scheduleNextRelayAlarm();
	}

	/**
	 * Schedule the next daily-relay alarm based on founder_context.tz +
	 * founder_context.relayHourLocal (defaults: UTC + 9am).
	 *
	 * Called from `setFounderContext` when the user changes tz or
	 * relayHourLocal, and from `alarm()` itself for self-rescheduling
	 * after each fire (5.1c.13).
	 *
	 * `ctx.storage.setAlarm` REPLACES any existing alarm — guaranteed
	 * single-alarm semantics regardless of how often we call this.
	 */
	private scheduleNextRelayAlarm(): void {
		this.ensureSchema();
		const ctxRows = this.ctx.storage.sql
			.exec<{ key: string; value: string }>(
				"SELECT key, value FROM founder_context WHERE key IN ('tz', 'relayHourLocal')",
			)
			.toArray();
		const ctx = Object.fromEntries(ctxRows.map((r) => [r.key, r.value]));
		const tz = ctx.tz ?? "UTC";
		const hour = Number(ctx.relayHourLocal ?? "9");
		const nextMs = computeNextDailyAt(tz, hour, Date.now());
		this.ctx.storage.setAlarm(nextMs);
	}

	/**
	 * Daily-relay alarm handler. Fires when the DO's `setAlarm` deadline lands.
	 *
	 * Behavior (per spec §3.2 + Phase-0c verifications):
	 *  - If `founder_context.productName` is unset, skip the synthetic turn
	 *    (the founder may set it later; still reschedule for tomorrow).
	 *  - Otherwise inject a system-role synthetic message and trigger an LLM
	 *    turn via `saveMessages` (function form to avoid stale-baseline races —
	 *    see Phase-0c §1). The LLM's response auto-persists into
	 *    `cf_ai_chat_agent_messages` and is broadcast to any connected WS
	 *    clients (silent no-op if zero clients are connected).
	 *  - `saveMessages` returns `{ requestId, status }`. `status='skipped'`
	 *    and `status='aborted'` are NON-ERROR terminals — log telemetry and
	 *    reschedule, don't retry.
	 *  - On thrown error, log + reschedule (self-healing).
	 *  - ALWAYS call `scheduleNextRelayAlarm()` at the end.
	 *
	 * Telemetry events on Analytics Engine:
	 *  - `relay-skip-no-product` — productName unset, turn skipped
	 *  - `relay-fired`           — turn completed normally
	 *  - `relay-skipped`         — turn returned status='skipped'
	 *  - `relay-aborted`         — turn returned status='aborted'
	 *  - `relay-failed`          — turn threw; first 200 chars of error msg
	 *  - `relay-dryrun`          — test-mode dry-run (skips turn body)
	 *
	 * Test seams (only honored in unit tests; never set in prod):
	 *  - `_alarmDryRun: true`           — emit `relay-dryrun` + reschedule;
	 *                                     skip `runRelayTurn` (no LLM call).
	 *  - `_alarmInjectError: string`    — emit `relay-failed` with the given
	 *                                     message + reschedule; skip
	 *                                     `runRelayTurn`. Exercises the
	 *                                     self-healing reschedule path
	 *                                     without needing a real LLM throw.
	 */
	async alarm(): Promise<void> {
		this.ensureSchema();
		const productNameRow = this.ctx.storage.sql
			.exec<{ value: string }>(
				"SELECT value FROM founder_context WHERE key = 'productName'",
			)
			.toArray()[0];
		const hasProduct = productNameRow != null && productNameRow.value !== "";

		if (!hasProduct) {
			writeAgentEvent(this.env, {
				kind: "agent_run",
				userId: this.name,
				blobs: ["CMO", "relay-skip-no-product"],
				doubles: [0],
			});
		} else {
			const seams = this as unknown as {
				_alarmDryRun?: boolean;
				_alarmInjectError?: string;
			};
			if (seams._alarmDryRun) {
				writeAgentEvent(this.env, {
					kind: "agent_run",
					userId: this.name,
					blobs: ["CMO", "relay-dryrun"],
					doubles: [0],
				});
			} else if (seams._alarmInjectError) {
				// Test seam: simulate a thrown error from runRelayTurn.
				writeAgentEvent(this.env, {
					kind: "agent_run",
					userId: this.name,
					blobs: [
						"CMO",
						"relay-failed",
						seams._alarmInjectError.slice(0, 200),
					],
					doubles: [0],
				});
			} else {
				try {
					const status = await this.runRelayTurn();
					const eventKind =
						status === "skipped"
							? "relay-skipped"
							: status === "aborted"
								? "relay-aborted"
								: "relay-fired";
					writeAgentEvent(this.env, {
						kind: "agent_run",
						userId: this.name,
						blobs: ["CMO", eventKind],
						doubles: [0],
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					writeAgentEvent(this.env, {
						kind: "agent_run",
						userId: this.name,
						blobs: ["CMO", "relay-failed", msg.slice(0, 200)],
						doubles: [0],
					});
				}
			}
		}

		// Always reschedule (self-healing — even on skip / fail / abort).
		this.scheduleNextRelayAlarm();
	}

	/**
	 * Inject a synthetic system-role message and drive an LLM turn via
	 * `saveMessages` (function form). The LLM's response is auto-persisted
	 * by AIChatAgent's built-in machinery; the founder reads it on next
	 * WS connect.
	 *
	 * Per Phase-0c verifications (docs/superpowers/specs/2026-05-17-phase-0c-verifications.md):
	 *  - Use the function-form callback so the messages baseline reflects
	 *    any persisted state at save time (not a stale snapshot from when
	 *    `alarm()` started).
	 *  - The message shape is AI SDK v6 `UIMessage` —
	 *    `{ id, role, parts, metadata }`. There is no top-level `content` or
	 *    `createdAt` field; we put `firedAt` inside `metadata`.
	 *  - ID is `relay-${crypto.randomUUID()}` (not `Date.now()`) to avoid PK
	 *    collisions on same-ms double-fire.
	 *
	 * Returns the SDK's `status` so the caller can emit per-state telemetry.
	 * `'completed'` is the normal path; `'skipped'` / `'aborted'` are
	 * non-error terminals (e.g. founder cleared the chat mid-flight).
	 */
	private async runRelayTurn(): Promise<
		"completed" | "skipped" | "aborted"
	> {
		const synthetic: UIMessage = {
			id: `relay-${crypto.randomUUID()}`,
			role: "system",
			parts: [{ type: "text", text: SYNTHETIC_CRON_PROMPT }],
			metadata: {
				source: "daily-relay",
				firedAt: new Date().toISOString(),
			},
		};
		const result = await this.saveMessages(
			(current) => [...current, synthetic],
		);
		return result.status;
	}

	/**
	 * 7.1 — Synchronous one-shot tool dispatch for external MCP callers.
	 *
	 * Currently supports `chat`: appends a user-role message representing
	 * the external client's question via `saveMessages` (function form, same
	 * primitive as `runRelayTurn`), then reads back the resulting assistant
	 * message and returns its text. No WS / streaming; external callers
	 * want a JSON reply.
	 *
	 * Dry-run seam: if `this._invokeAsToolDryRun` is set (a string), returns
	 * it as the reply and skips both the message append AND the LLM call.
	 * Same pattern as `_alarmDryRun` (5.1c.13). Used by vitest-pool-workers
	 * tests since `vi.mock` doesn't propagate into the worker bundle
	 * (resume-note). Phase 7.5 manual smoke exercises the real path.
	 *
	 * Visibility: PUBLIC — Phase 7.2's `CmoExternalMcp` invokes this via the
	 * Durable Object RPC stub. The Cloudflare DO RPC pattern auto-exposes
	 * public methods to sibling Workers / namespaces.
	 *
	 * Returns the assistant's reply text. Throws on unknown tool name or
	 * if `saveMessages` reports a non-`completed` status (e.g. founder
	 * cleared chat mid-flight = `skipped`; external abort = `aborted`).
	 */
	public async invokeAsTool(
		tool: "chat",
		args: { message: string },
	): Promise<string> {
		if (tool !== "chat") {
			throw new Error(`invokeAsTool: unknown tool '${tool}'`);
		}
		this.ensureSchema();

		const dryRun = (this as unknown as { _invokeAsToolDryRun?: string })
			._invokeAsToolDryRun;
		if (dryRun !== undefined) {
			return dryRun;
		}

		const userMessage: UIMessage = {
			id: `external-${crypto.randomUUID()}`,
			role: "user",
			parts: [{ type: "text", text: args.message }],
			metadata: { source: "external-mcp", firedAt: Date.now() },
		};
		const result = await this.saveMessages((current) => [
			...current,
			userMessage,
		]);
		if (result.status !== "completed") {
			throw new Error(
				`invokeAsTool: saveMessages returned status='${result.status}'`,
			);
		}

		// Find the most recent assistant message — that's the reply to our
		// user message. `this.messages` is AIChatAgent's canonical source.
		const messages = this.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role === "assistant") {
				return extractTextFromUIMessage(m);
			}
		}
		throw new Error("invokeAsTool: no assistant reply found");
	}

	/**
	 * P2-F — Web push subscription persistence.
	 *
	 * Browser → `/api/push/subscribe` (apps/web, session-gated) → this
	 * route via Service Binding. Endpoint is the primary key — re-subscribe
	 * from the same browser yields the same endpoint, so an UPSERT
	 * refreshes the keys + clears `last_error`.
	 */
	private async handlePushSubscribe(request: Request): Promise<Response> {
		let body: PushSubscriptionRow;
		try {
			body = (await request.json()) as PushSubscriptionRow;
		} catch {
			return new Response("invalid json", { status: 400 });
		}
		if (
			typeof body.endpoint !== "string" ||
			typeof body.p256dh !== "string" ||
			typeof body.auth !== "string" ||
			body.endpoint.length === 0
		) {
			return new Response("invalid subscription", { status: 400 });
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscribed_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET
			   p256dh = excluded.p256dh,
			   auth = excluded.auth,
			   last_error = NULL`,
			body.endpoint,
			body.p256dh,
			body.auth,
			Date.now(),
		);
		return new Response("subscribed", { status: 200 });
	}

	/**
	 * Wipe all per-DO SQLite tables for this user. Called from
	 * `/api/account` DELETE (via apps/web service binding) as part of
	 * account deletion. Best-effort — D1 hard-delete fires regardless.
	 *
	 * Drops every table that isn't an sqlite internal — covers both
	 * applyCmoSchema tables and AIChatAgent's chat-history tables.
	 */
	private handleDestroy(): Response {
		const tables = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
			)
			.toArray();
		for (const t of tables) {
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${t.name}"`);
		}
		return new Response("destroyed", { status: 200 });
	}

	/**
	 * Onboarding commit — writes a new strategic_path version from the
	 * onboarding flow directly into CMO SQLite, bypassing the LLM
	 * tool-call path. Triggered via Service Binding from `apps/web`'s
	 * `/api/onboarding/commit` route.
	 *
	 * Body: `{ theme: string, narrative: Record<string, unknown>, generatedBy: string }`
	 *
	 * Returns: `{ id: string, version: number }`
	 */
	private async handleCommitStrategicPath(
		request: Request,
	): Promise<Response> {
		const body = (await request.json()) as {
			theme: string;
			narrative: Record<string, unknown>;
			generatedBy: string;
		};
		const id = crypto.randomUUID();
		const latest = this.ctx.storage.sql
			.exec<{ v: number }>(
				"SELECT COALESCE(MAX(version), 0) as v FROM strategic_path",
			)
			.one();
		const version = latest.v + 1;
		this.ctx.storage.sql.exec(
			`INSERT INTO strategic_path
			   (id, version, theme, narrative_json, status, generated_at, generated_by)
			 VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
			id,
			version,
			body.theme,
			JSON.stringify(body.narrative),
			Date.now(),
			body.generatedBy,
		);
		return Response.json({ id, version });
	}

	/**
	 * P2-F — Send a Web Push notification to every active subscription for
	 * this founder. Public so wiring it into draft-ready hooks doesn't need
	 * a new tool. Returns `{ sent, failed }`.
	 */
	async sendPushToFounder(
		payload: PushPayload,
	): Promise<{ sent: number; failed: number }> {
		this.ensureSchema();
		const subs = this.ctx.storage.sql
			.exec<PushSubscriptionRow>(
				"SELECT endpoint, p256dh, auth FROM push_subscriptions",
			)
			.toArray();

		const vapid = {
			publicKey: this.env.VAPID_PUBLIC,
			privateKey: this.env.VAPID_PRIVATE,
			subject: this.env.VAPID_SUBJECT || "mailto:hello@shipflare.com",
		};

		let sent = 0;
		let failed = 0;
		for (const sub of subs) {
			try {
				const result = await sendWebPush(sub, payload, vapid);
				if (result.ok) {
					sent++;
					this.ctx.storage.sql.exec(
						"UPDATE push_subscriptions SET last_used = ?, last_error = NULL WHERE endpoint = ?",
						Date.now(),
						sub.endpoint,
					);
				} else {
					failed++;
					if (result.shouldDelete) {
						this.ctx.storage.sql.exec(
							"DELETE FROM push_subscriptions WHERE endpoint = ?",
							sub.endpoint,
						);
					} else {
						this.ctx.storage.sql.exec(
							"UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?",
							String(result.status),
							sub.endpoint,
						);
					}
				}
			} catch (err) {
				failed++;
				console.error(`[CMO push] send failed for ${sub.endpoint}:`, err);
				this.ctx.storage.sql.exec(
					"UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?",
					err instanceof Error ? err.message : String(err),
					sub.endpoint,
				);
			}
		}
		return { sent, failed };
	}
}
