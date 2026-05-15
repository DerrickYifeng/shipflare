import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { getAuth } from "@/auth";
import { getAnthropic } from "@/lib/anthropic";
import {
  strategicPathSchema,
  type StrategicPath,
} from "@/lib/strategic-path-schema";
import { derivePhase } from "@/lib/launch-phase";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const HEARTBEAT_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 180_000;

const requestBodySchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: z.enum([
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ]),
    targetAudience: z.string().max(600).nullable().optional(),
  }),
  channels: z.array(z.enum(["x", "reddit", "email"])).min(1),
  state: z.enum(["mvp", "launching", "launched"]),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: z.enum(["producthunt", "showhn", "both", "other"]).nullable().optional(),
  usersBucket: z.enum(["<100", "100-1k", "1k-10k", "10k+"]).nullable().optional(),
});

type RequestBody = z.infer<typeof requestBodySchema>;

const SYSTEM_PROMPT = `You are the Head of Growth for an indie product. Produce a 30-day marketing strategy as a strict JSON object matching this Zod-style shape:

{
  "narrative": string (200-2400 chars, 2-3 paragraphs explaining the strategic thesis),
  "milestones": Array<{ title: string, summary: string, dueOffsetDays: number }>, // 3-12 items
  "thesisArc": Array<{
    weekStart: string (YYYY-MM-DD, Monday UTC),
    theme: string,
    posts: { x?: number, reddit?: number, email?: number }
  }>, // 1-12 weeks
  "contentPillars": string[] (3-4 short labels),
  "channelMix": {
    "x"?: { cadencePerWeek: number, repliesPerDay?: number },
    "reddit"?: { cadencePerWeek: number },
    "email"?: { cadencePerWeek: number }
  } (at least one channel non-null, matching connected channels),
  "phaseGoals": {
    "foundation"?: string, "audience"?: string, "momentum"?: string,
    "launch"?: string, "compound"?: string, "steady"?: string
  } (at least the entry matching currentPhase is set)
}

Anchor thesisArc[0].weekStart at the Monday 00:00 UTC of the week containing today.
Tailor channelMix to ONLY the channels passed in input.channels.
Respond with ONLY the JSON object, no surrounding prose.`;

function isoMondayUTC(d: Date): string {
  const date = new Date(d);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: RequestBody;
  try {
    body = requestBodySchema.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid body";
    return NextResponse.json({ error: "invalid_request", detail }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = derivePhase({ state: body.state, launchDate, launchedAt });
  const today = new Date();
  const weekStart = isoMondayUTC(today);

  const userMessage = JSON.stringify(
    {
      today: today.toISOString().slice(0, 10),
      weekStart,
      product: body.product,
      state: body.state,
      currentPhase,
      channels: body.channels,
      launchDate: body.launchDate ?? null,
      launchedAt: body.launchedAt ?? null,
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
    },
    null,
    2,
  );

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller closed by client
        }
      };
      const cleanup = (terminal: Record<string, unknown>) => {
        if (closed) return;
        send(terminal);
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timeoutId) clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
      timeoutId = setTimeout(() => abortController.abort(), TIMEOUT_MS);

      try {
        const client = getAnthropic(env.ANTHROPIC_API_KEY!);
        const response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          },
          { signal: abortController.signal },
        );
        const text =
          response.content[0]?.type === "text" ? response.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          cleanup({ type: "error", error: "no_json_in_response" });
          return;
        }
        const raw = JSON.parse(jsonMatch[0]);
        const path: StrategicPath = strategicPathSchema.parse(raw);
        cleanup({ type: "strategic_done", path });
      } catch (err) {
        if (abortController.signal.aborted) {
          cleanup({ type: "error", error: "planner_timeout" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`onboarding/plan failed user=${userId}:`, message);
        cleanup({ type: "error", error: "PlanGenerationError" });
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timeoutId) clearTimeout(timeoutId);
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
