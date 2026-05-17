import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	createUIMessageStream,
	createUIMessageStreamResponse,
	convertToModelMessages,
	tool,
	type StreamTextOnFinishCallback,
	type ToolSet,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeAgentEvent } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCmoSchema } from "./schema";
import { makeConsultTool } from "../lib/consult-tool";
import { loadSystemPrompt } from "../lib/system-prompt";
import {
	sendWebPush,
	type PushPayload,
	type PushSubscriptionRow,
} from "../../lib/web-push";
import { handleInternalJson } from "../../lib/internal-route";
import { mirrorDraftBodySchema } from "../../lib/mirror-draft";

export interface CMOState {
	currentRunId: string | null;
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
 *   - /internal/cron-tick               — periodic wake; currently a no-op
 *                                          stub (peer fan-out was deleted
 *                                          alongside the McpAgent surface)
 *   - /internal/push-subscribe          — web-push subscription persistence
 *   - /internal/destroy                 — account-deletion cleanup
 *   - /internal/commit-strategic-path   — onboarding-wizard direct write
 *   - /internal/mirror-draft            — SMM/HoG shadow-POST when a draft hits status='ready'
 *
 * The legacy /internal/log-activity route + the activity_events table are
 * deleted in this commit (telemetry routes through Analytics Engine via
 * `writeAgentEvent` instead).
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
				execute: async () => {
					self.ensureSchema();
					const rows = self.ctx.storage.sql
						.exec<{ key: string; value: string }>(
							"SELECT key, value FROM founder_context",
						)
						.toArray();
					return Object.fromEntries(rows.map((r) => [r.key, r.value]));
				},
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
				execute: async ({ status, ownerRole, limit }) => {
					self.ensureSchema();
					let q =
						"SELECT id, skill, channel, params_json, status, owner_role, scheduled_for, started_at, completed_at FROM plan_items WHERE 1=1";
					const bindings: unknown[] = [];
					if (status) {
						q += " AND status = ?";
						bindings.push(status);
					}
					if (ownerRole) {
						q += " AND owner_role = ?";
						bindings.push(ownerRole);
					}
					q +=
						" ORDER BY scheduled_for IS NULL, scheduled_for ASC, plan_version ASC LIMIT ?";
					bindings.push(limit);
					return self.ctx.storage.sql
						.exec(q, ...(bindings as SqlStorageValue[]))
						.toArray();
				},
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
				execute: async ({ limit }) => {
					self.ensureSchema();
					// The post-rewrite path reads drafts directly from approval_queue
					// (CMO is the sole writer post-Phase-5). The legacy MCP tool RPC'd
					// to SMM.list_drafts; that path is gone alongside the McpAgent
					// surface. The legacy `status` filter param was dropped —
					// approval_queue.decision is the authoritative state, and the
					// queue is empty until SMM-side draft mirroring lands in Task
					// 5.1c. Status filtering will be re-added then.
					return self.ctx.storage.sql
						.exec(
							`SELECT id, draft_id, employee, kind, channel, preview, created_at, decided_at, decision
							 FROM approval_queue
							 ORDER BY created_at DESC
							 LIMIT ?`,
							limit,
						)
						.toArray();
				},
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
				execute: async ({ limit }) => {
					self.ensureSchema();
					return self.ctx.storage.sql
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
				},
			}),

			queryAgentTranscript: tool({
				description:
					"List recent employee_log entries authored by the given role, newest first. Useful for reviewing what a colleague has been doing.",
				inputSchema: z.object({
					role: z.string().min(1),
					limit: z.number().int().positive().max(200).default(100),
				}),
				execute: async ({ role, limit }) => {
					self.ensureSchema();
					return self.ctx.storage.sql
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
							role,
							limit,
						)
						.toArray();
				},
			}),
		};
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

		if (url.pathname === "/internal/init") {
			this.ensureSchema();
			return this.handleInit(request);
		}
		if (url.pathname === "/internal/peer-dm-shadow") {
			this.ensureSchema();
			return this.handlePeerShadow(request);
		}
		if (url.pathname === "/internal/cron-tick") {
			this.ensureSchema();
			return this.handleCronTick();
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
					}

					writeAgentEvent(this.env, {
						kind: "agent_run",
						userId: this.name,
						blobs: ["CMO", "draft-mirrored", body.employee, body.channel, body.kind],
						doubles: [0],
					});

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
	 * Cron tick — called from `apps/core`'s `scheduled()` handler on every
	 * cron trigger.
	 *
	 * Post-Phase-5 status: this is a stub. The legacy McpAgent CMO fanned
	 * out to SMM's `findThreadsViaXai` via in-process MCP RPC; with peers
	 * now AIChatAgents reached only via `consult`, the cron-tick driven
	 * fan-out is no longer wired. Task 5.1c brings the sweep back in by
	 * re-implementing the deleted SMM tools as CMO-side LLM tools that
	 * the cron tick can drive via a synthetic chat turn.
	 *
	 * Until then this returns 200 noop so the Worker's `scheduled()` loop
	 * stays self-healing and tests that don't depend on the fan-out can
	 * still assert "tick happened" semantics.
	 */
	private handleCronTick(): Response {
		// Observability: emit a telemetry event for every tick so we can
		// confirm crons are firing (and measure the cost of the no-op
		// invocations) before 5.1c restores real fan-out behavior.
		writeAgentEvent(this.env, {
			kind: "agent_run",
			userId: this.name,
			blobs: ["CMO", "cron-tick-noop"],
			doubles: [0],
		});
		return new Response(`noop:cron-tick-stub:${this.name}`, { status: 200 });
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
