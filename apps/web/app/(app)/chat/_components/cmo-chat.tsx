"use client";
import { useState, type FormEvent } from "react";
import { useCmoChat } from "@/hooks/use-cmo-chat";
import type { UIMessage } from "ai";
import { MessageBubble } from "./message-bubble";
import { TextPart } from "./text-part";
import { ReasoningPart } from "./reasoning-part";
import { ToolInvocation } from "./tool-invocation";
import type { ToolInvocationData } from "./tool-invocation";
import { NestedAgentRun } from "./nested-agent-run";
import { SkillPart } from "./skill-part";
import { StepAnchor } from "./step-anchor";
import { EMPLOYEE_REGISTRY } from "@/lib/employee-registry-client";

export function CmoChat({ userId }: { userId: string }) {
	const { messages, sendMessage, isStreaming, agentRunsByToolCall } = useCmoChat({ userId });
	const [input, setInput] = useState("");

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		const trimmed = input.trim();
		if (!trimmed) return;
		sendMessage({ text: trimmed });
		setInput("");
	}

	return (
		<div className="flex flex-col h-full max-w-3xl mx-auto">
			<div className="flex-1 overflow-y-auto p-4">
				{messages.map((msg: UIMessage) => (
					<MessageBubble key={msg.id} role={msg.role}>
						{msg.parts.map((part: unknown, i: number) => {
							const p = part as Record<string, unknown>;
							const typeStr = String(p["type"] ?? "");

							if (typeStr === "text") {
								return <TextPart key={i} text={String(p["text"] ?? "")} />;
							}
							if (typeStr === "reasoning") {
								return (
									<ReasoningPart
										key={i}
										text={String(p["text"] ?? "")}
										isStreaming={isStreaming}
									/>
								);
							}
							if (typeStr === "data-skill-start" || typeStr === "data-skill-finish") {
								return (
									<SkillPart
										key={i}
										part={
											p as unknown as Parameters<
												typeof SkillPart
											>[0]["part"]
										}
									/>
								);
							}
							if (typeStr === "data-step") {
								return (
									<StepAnchor
										key={i}
										part={p as Parameters<typeof StepAnchor>[0]["part"]}
									/>
								);
							}

							// tool-<name> or dynamic-tool
							if (typeStr.startsWith("tool-") || typeStr === "dynamic-tool") {
								const toolName =
									typeStr === "dynamic-tool"
										? String(p["toolName"] ?? "")
										: typeStr.replace(/^tool-/, "");
								const toolCallId = String(p["toolCallId"] ?? "");

								if (toolName === "consult") {
									const input = p["input"];
									const employeeId =
										input && typeof input === "object" && "employee" in input
											? String((input as Record<string, unknown>)["employee"] ?? "")
											: "";
									const meta = EMPLOYEE_REGISTRY[employeeId];
									return (
										<NestedAgentRun
											key={i}
											label={meta?.displayName ?? employeeId}
											childRun={
												agentRunsByToolCall[toolCallId] as Parameters<
													typeof NestedAgentRun
												>[0]["childRun"]
											}
										/>
									);
								}

								const invocation: ToolInvocationData = {
									toolCallId,
									toolName,
									state:
										(p["state"] as ToolInvocationData["state"]) ??
										"input-available",
									input: p["input"],
									output: p["output"],
									errorText:
										typeof p["errorText"] === "string"
											? p["errorText"]
											: undefined,
								};
								return <ToolInvocation key={i} invocation={invocation} />;
							}

							return null;
						})}
					</MessageBubble>
				))}
			</div>
			<form onSubmit={handleSubmit} className="border-t p-3 flex gap-2">
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask CMO…"
					className="flex-1 border rounded px-3 py-2"
					aria-label="message"
				/>
				<button
					type="submit"
					disabled={isStreaming || !input.trim()}
					className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
				>
					Send
				</button>
			</form>
		</div>
	);
}
