import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { products } from "@shipflare/db";
import { ProductContent, type ProductSnapshot } from "./product-content";

export const dynamic = "force-dynamic";

export default async function ProductPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const { env } = getCloudflareContext();
  const db = getDb(env);

  const row = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  const initial: ProductSnapshot = row
    ? {
        name: row.name,
        description: row.description,
        keywords: row.keywords ?? [],
        valueProp: row.valueProp,
        url: row.url,
        state: row.state as ProductSnapshot["state"],
        launchDate: row.launchDate ? row.launchDate.toISOString() : null,
        launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      }
    : {
        name: null,
        description: null,
        keywords: [],
        valueProp: null,
        url: null,
        state: "draft" as const,
        launchDate: null,
        launchedAt: null,
        updatedAt: null,
        createdAt: null,
      };

  return <ProductContent initial={initial} />;
}
