import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	createUIMessageStream,
	createUIMessageStreamResponse,
	convertToModelMessages,
	type StreamTextOnFinishCallback,
	type ToolSet,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { makeConsultTool } from "../lib/consult-tool";
import { loadSystemPrompt } from "../lib/system-prompt";
import { applyHogSchema } from "./schema";
import type { Env } from "../../index";

export interface HoGState {
	currentRunId: string | null;
}

/**
 * Head of Growth — strategic-consultant AIChatAgent.
 *
 * Post-Phase-4 migration: HoG no longer generates strategic_path versions
 * or audits plan_items directly — those move to CMO-side tools in Phase 5.
 * HoG's surface is intentionally lean: just `consult` (the generic peer
 * dispatcher from lib/consult-tool.ts).
 *
 * Per spec §3.4 of the CF-native chat migration design. The HoG-direct
 * tools `research_competitor` + `analyze_funnel` ship in a follow-up
 * (Task 4.5e — analogous to SMM's deferred Task 4.4e).
 */
export class HoG extends AIChatAgent<Env, HoGState> {
	initialState: HoGState = { currentRunId: null };

	private _schemaApplied = false;

	private ensureSchema(): void {
		if (this._schemaApplied) return;
		applyHogSchema(this.ctx.storage.sql);
		this._schemaApplied = true;
	}

	async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
		this.ensureSchema();
		const messages = await convertToModelMessages(this.messages);
		const system = await loadSystemPrompt("hog");
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
					onFinish,
				});
				writer.merge(result.toUIMessageStream());
			},
		});

		return createUIMessageStreamResponse({ stream });
	}

	getTools(): ToolSet {
		return {
			consult: makeConsultTool("hog"),
		};
	}
}
