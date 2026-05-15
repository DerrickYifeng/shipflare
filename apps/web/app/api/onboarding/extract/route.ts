import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { scrapeWebsite, analyzeWebsite } from "@/lib/scraper";
import { auditSeo } from "@/lib/seo-audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }
  const { env } = getCloudflareContext();
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }
  const scraped = await scrapeWebsite(body.url);
  const [analysis, seoAudit] = await Promise.all([
    analyzeWebsite(scraped, anthropicKey),
    auditSeo(body.url),
  ]);
  return NextResponse.json({
    url: body.url,
    name: analysis.productName,
    description: analysis.oneLiner,
    keywords: analysis.keywords,
    valueProp: analysis.valueProp,
    targetAudience: analysis.targetAudience,
    ogImage: scraped.ogImage,
    seoAudit,
  });
}
