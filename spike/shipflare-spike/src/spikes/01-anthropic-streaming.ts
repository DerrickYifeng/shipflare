import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";

export default async function handler(
  _req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    messages: [
      { role: "user", content: "What's the weather in Tokyo? Use the tool." },
    ],
  });

  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  const final = await stream.finalMessage();

  const toolUse = final.content.find((c) => c.type === "tool_use");
  return Response.json({
    eventCount: events.length,
    eventTypes: [...new Set(events)],
    stopReason: final.stop_reason,
    hasToolUse: !!toolUse,
    toolUseId: toolUse?.id ?? null,
    toolName: toolUse && "name" in toolUse ? toolUse.name : null,
  });
}
