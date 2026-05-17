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
import { runSkill } from "@shipflare/skills";
import { makeConsultTool } from "../lib/consult-tool";
import { loadSystemPrompt } from "../lib/system-prompt";
import { applySmmSchema } from "./schema";
import { makeFindThreadsViaXaiTool } from "./tools/find-threads-via-xai";
import { makeFindThreadsTool } from "./tools/find-threads";
import { makeResearchRedditChannelsTool } from "./tools/research-reddit-channels";
import type { Env } from "../../index";

export interface SMMState {
	currentRunId: string | null;
}

/**
 * Social Media Manager — drafting-only AIChatAgent.
 *
 * Post-Phase-4 migration: SMM no longer does discovery, persistence, or
 * batch orchestration — those move to CMO-side tools in Phase 5 (Task 4.4e).
 * SMM's surface is intentionally lean: just `consult` (the generic peer
 * dispatcher from lib/consult-tool.ts) and `draft_for_channel` (calls into
 * the drafting-single-post skill).
 *
 * Per spec §3.4 of the CF-native chat migration design.
 */
export class SMM extends AIChatAgent<Env, SMMState> {
	initialState: SMMState = { currentRunId: null };

	private _schemaApplied = false;

	private ensureSchema(): void {
		if (this._schemaApplied) return;
		applySmmSchema(this.ctx.storage.sql);
		this._schemaApplied = true;
	}

	/**
	 * Narrow accessors so tool-registration modules (which live outside the
	 * class and therefore can't see `protected` DurableObject members) can
	 * reach the raw SQL storage and Worker env. Same pattern as CMO/HoG
	 * (S2.1 / S3.0) and XMcpAgent/RedditMcpAgent. `sqlStorage` instead of
	 * `sql` because the parent `Agent` class already exposes a `sql`
	 * template-tag method; `bindings` instead of `env` because `env` is a
	 * protected DurableObject member.
	 */
	get sqlStorage(): SqlStorage {
		return this.ctx.storage.sql;
	}
	get bindings(): Env {
		return this.env;
	}

	async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
		this.ensureSchema();
		const messages = await convertToModelMessages(this.messages);
		const system = await loadSystemPrompt("smm");
		const tools = this.getTools();
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
					onFinish,
				});
				writer.merge(result.toUIMessageStream());
			},
		});
		return createUIMessageStreamResponse({ stream });
	}

	getTools(): ToolSet {
		this.ensureSchema();
		return {
			consult: makeConsultTool("smm"),
			draft_for_channel: tool({
				description: "Draft content for a specific social channel.",
				inputSchema: z.object({
					channel: z.enum(["x", "reddit"]),
					topic: z.string(),
					tone: z.string().optional(),
				}),
				execute: async (args, ctx) => {
					const exp = ctx.experimental_context as
						| {
								writer?: { write: (chunk: unknown) => void };
								userId?: string;
								env?: Env;
						  }
						| undefined;
					return await runSkill({
						name: "drafting-post",
						args,
						writer: exp?.writer,
						userId: exp?.userId,
						env: (exp?.env ?? {}) as Env & { ANTHROPIC_API_KEY: string },
					});
				},
			}),
			find_threads_via_xai: makeFindThreadsViaXaiTool(this),
			find_threads: makeFindThreadsTool(this),
			research_reddit_channels: makeResearchRedditChannelsTool(this),
		};
	}
}
