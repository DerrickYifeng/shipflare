import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products, codeSnapshots, accounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { HeaderBar } from '@/components/layout/header-bar';
import { ProductInfoSection } from '@/components/product/product-info-section';
import { CodeSnapshotSection } from '@/components/product/code-snapshot-section';
import { WebsiteInfoSection } from '@/components/product/website-info-section';
import type { SeoAuditResult } from '@/tools/seo-audit';
import type { TechStack } from '@/types/code-scanner';

export default async function ProductPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) redirect('/onboarding');

  const [snapshot] = await db
    .select()
    .from(codeSnapshots)
    .where(eq(codeSnapshots.productId, product.id))
    .limit(1);

  const [githubAccount] = await db
    .select({ providerAccountId: accounts.providerAccountId })
    .from(accounts)
    .where(and(eq(accounts.userId, session.user.id), eq(accounts.provider, 'github')))
    .limit(1);

  const serializedSnapshot = snapshot
    ? {
        repoFullName: snapshot.repoFullName,
        repoUrl: snapshot.repoUrl,
        techStack: snapshot.techStack as TechStack,
        scanSummary: snapshot.scanSummary,
        commitSha: snapshot.commitSha,
        scannedAt: snapshot.scannedAt.toISOString(),
      }
    : null;

  return (
    <>
      <HeaderBar title="My Product" />
      <div className="max-w-[640px] mx-auto p-6 flex flex-col gap-8">
        <ProductInfoSection
          product={{
            name: product.name,
            description: product.description,
            keywords: product.keywords,
            valueProp: product.valueProp,
          }}
        />
        <CodeSnapshotSection
          snapshot={serializedSnapshot}
          hasGitHub={!!githubAccount}
        />
        <WebsiteInfoSection
          url={product.url}
          seoAudit={product.seoAuditJson as SeoAuditResult | null}
        />
      </div>
    </>
  );
}
