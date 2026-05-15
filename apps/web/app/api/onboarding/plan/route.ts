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

const SYSTEM_PROMPT = `You are the Head of Growth for an indie product. Produce a 30-day marketing strategy as a strict JSON object.

EXACT REQUIRED SHAPE (field names must match exactly — no substitutions):

{
  "narrative": string,           // 200–2400 chars, 2–3 paragraphs explaining strategic thesis
  "milestones": [                // 3–12 items
    {
      "atDayOffset": number,     // integer, days from today (e.g. 7, 14, 30)
      "title": string,           // max 140 chars
      "successMetric": string,   // max 240 chars — measurable success criteria
      "phase": string            // MUST be one of: "foundation" | "audience" | "momentum" | "launch" | "compound" | "steady"
    }
  ],
  "thesisArc": [                 // 1–12 items, one per week
    {
      "weekStart": string,       // YYYY-MM-DD, Monday 00:00 UTC
      "theme": string,           // max 240 chars
      "angleMix": string[],      // REQUIRED, 1–7 items, each MUST be one of: "claim" | "story" | "contrarian" | "howto" | "data" | "case" | "synthesis"
      "posts": {                 // optional
        "x"?: number,            // 0–14
        "reddit"?: number,       // 0–14
        "email"?: number         // 0–14
      }
    }
  ],
  "contentPillars": string[],    // 3–4 short labels, max 60 chars each
  "channelMix": {                // at least one non-null; only include channels from input.channels
    "x"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours (0–23, e.g. [9, 13, 17])
      "preferredCommunities": string[] | null
    },
    "reddit"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours
      "preferredCommunities": string[] | null  // e.g. ["r/SaaS", "r/startups"]
    },
    "email"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours
      "preferredCommunities": string[] | null
    }
  },
  "phaseGoals": {                // all fields optional strings, max 240 chars each
    "foundation"?: string,
    "audience"?: string,
    "momentum"?: string,
    "launch"?: string,
    "compound"?: string,
    "steady"?: string
  }
}

CRITICAL RULES:
- Use "successMetric" NOT "summary" or "dueOffsetDays" — use "atDayOffset"
- "angleMix" is REQUIRED on every thesisArc entry (not optional)
- "preferredHours" is REQUIRED on every channelMix entry — must have 1–6 elements
- Only include channels in channelMix that appear in input.channels
- Anchor thesisArc[0].weekStart to the weekStart value from input (Monday 00:00 UTC)

VALID EXAMPLE (small but schema-compliant):
{
  "narrative": "This is a two-paragraph strategic narrative explaining the go-to-market approach for the product. It covers the core value proposition and target audience clearly. The second paragraph outlines the 30-day growth thesis and why these channels and cadences were chosen.",
  "milestones": [
    {"atDayOffset": 7, "title": "Soft launch on Show HN", "successMetric": "100 unique visits in first 24h", "phase": "momentum"},
    {"atDayOffset": 14, "title": "First 10 paying users", "successMetric": "10 active subscriptions", "phase": "launch"},
    {"atDayOffset": 30, "title": "Hit MRR target", "successMetric": "$1k MRR", "phase": "compound"}
  ],
  "thesisArc": [
    {"weekStart": "<weekStart from input>", "theme": "Build in public", "angleMix": ["story", "data"], "posts": {"x": 3, "reddit": 1}},
    {"weekStart": "<next Monday>", "theme": "Social proof", "angleMix": ["case", "claim"], "posts": {"x": 4}}
  ],
  "contentPillars": ["Product updates", "Industry insight", "Customer stories"],
  "channelMix": {
    "x": {"repliesPerDay": 5, "preferredHours": [9, 13, 17], "preferredCommunities": null},
    "reddit": {"repliesPerDay": 0, "preferredHours": [10, 15], "preferredCommunities": ["r/SaaS"]}
  },
  "phaseGoals": {
    "foundation": "Ship docs and landing page",
    "audience": "Grow X following to 500",
    "momentum": "100 signups before launch",
    "launch": "Hit 1k visits on launch day",
    "compound": "Convert 1% of visitors to paid",
    "steady": "Sustain $1k MRR"
  }
}

Respond with ONLY the JSON object, no surrounding prose or markdown fences.`;

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
