import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels, discoveryConfigs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { auditSeo } from '@/tools/seo-audit';
import { enqueueCalibration } from '@/lib/queue';
import { isPlatformAvailable } from '@/lib/platform-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:onboarding');

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string; name?: string; description?: string; keywords?: string[]; valueProp?: string; merge?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url, name, description, keywords, valueProp, merge } = body;
  log.info(`PUT /api/onboarding/profile name=${name} merge=${!!merge}`);

  if (!name || !description) {
    return NextResponse.json(
      { error: 'Name and description are required' },
      { status: 400 },
    );
  }

  const seoAudit = url ? await auditSeo(url) : null;

  // Upsert product
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  const PLACEHOLDER_NAMES = ['', 'Untitled Product'];
  const PLACEHOLDER_DESCS = ['', '-'];

  if (existing.length > 0 && merge) {
    // Merge: keep existing non-placeholder values, union keywords
    const prev = existing[0];
    const mergedName = PLACEHOLDER_NAMES.includes(prev.name) ? name : prev.name;
    const mergedDesc = PLACEHOLDER_DESCS.includes(prev.description) ? description : prev.description;
    const mergedKeywords = [...new Set([...prev.keywords, ...(keywords ?? [])])];
    const mergedValueProp = prev.valueProp || valueProp || null;

    await db
      .update(products)
      .set({
        ...(url !== undefined ? { url: url || null } : {}),
        name: mergedName,
        description: mergedDesc,
        keywords: mergedKeywords,
        valueProp: mergedValueProp,
        ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else if (existing.length > 0) {
    await db
      .update(products)
      .set({
        ...(url !== undefined ? { url: url || null } : {}),
        name,
        description,
        keywords: keywords ?? [],
        valueProp: valueProp ?? null,
        ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else {
    await db.insert(products).values({
      userId: session.user.id,
      url: url || null,
      name,
      description,
      keywords: keywords ?? [],
      valueProp: valueProp ?? null,
      seoAuditJson: seoAudit,
    });

    // Trigger calibration for new products
    const [newProduct] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.userId, session.user.id))
      .limit(1);

    if (newProduct) {
      // Create default discovery configs + enqueue calibration
      const userChannels = await db
        .select({ platform: channels.platform })
        .from(channels)
        .where(eq(channels.userId, session.user.id));

      const platforms = [
        ...new Set(userChannels.map((c) => c.platform)),
      ].filter(isPlatformAvailable);

      for (const platform of platforms) {
        await db
          .insert(discoveryConfigs)
          .values({
            userId: session.user.id,
            platform,
            calibrationStatus: 'pending',
          })
          .onConflictDoNothing();
      }

      if (platforms.length > 0) {
        await enqueueCalibration({
          userId: session.user.id,
          productId: newProduct.id,
        });
        log.info(
          `Enqueued calibration for new product ${newProduct.id}, platforms: ${platforms.join(', ')}`,
        );
      }
    }
  }

  return NextResponse.json({ success: true });
}
