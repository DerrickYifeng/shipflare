import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getGitHubToken, getRepoReadme } from "@/lib/github";
import { getAnthropic, type ProductAnalysis } from "@/lib/anthropic";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

const ANALYZE_PROMPT = `You analyze GitHub repositories to understand what product they offer.
Given the README content below, extract:

1. productName — the actual product name (not the org/owner)
2. oneLiner — one sentence describing what it does
3. targetAudience — who this is for (be specific)
4. keywords — 5-8 topic keywords a potential user would search for (lowercase)
5. valueProp — the core value proposition in one sentence

Respond with ONLY a JSON object:
{"productName":"...","oneLiner":"...","targetAudience":"...","keywords":["..."],"valueProp":"..."}`;

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { repoFullName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.repoFullName || !/^[\w.-]+\/[\w.-]+$/.test(body.repoFullName)) {
    return NextResponse.json({ error: "Invalid repo format" }, { status: 400 });
  }
  const repoFullName = body.repoFullName;
  const { env } = getCloudflareContext();
  const db = getDb(env);
  const token = await getGitHubToken(db, session.user.id);
  if (!token) {
    return NextResponse.json({ error: "No GitHub account linked" }, { status: 404 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        send({ type: "progress", phase: "fetching_readme" });
        const readme = await getRepoReadme(token, repoFullName);
        send({ type: "progress", phase: "analyzing" });
        const client = getAnthropic(env.ANTHROPIC_API_KEY!);
        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          system: ANALYZE_PROMPT,
          messages: [
            {
              role: "user",
              content: `Repo: github.com/${repoFullName}\n\nREADME:\n${readme.slice(0, 50_000)}`,
            },
          ],
        });
        const text =
          response.content[0]?.type === "text" ? response.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in response");
        const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
        send({
          type: "complete",
          profile: {
            url: `https://github.com/${repoFullName}`,
            name: parsed.productName ?? repoFullName.split("/")[1],
            description: parsed.oneLiner ?? "",
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
            valueProp: parsed.valueProp ?? "",
            targetAudience: parsed.targetAudience ?? "",
            ogImage: null,
            seoAudit: null,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
