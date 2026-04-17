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

  let body: { url?: string; name?: string; description?: string; keywords?: string[]; valueProp?: string; lifecyclePhase?: string; merge?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url, name, description, keywords, valueProp, lifecyclePhase, merge } = body;
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

  const prev = existing[0] ?? null;

  if (prev && merge) {
    // Merge: keep existing non-placeholder values, union keywords
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
        ...(lifecyclePhase ? { lifecyclePhase } : {}),
        ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else if (prev) {
    await db
      .update(products)
      .set({
        ...(url !== undefined ? { url: url || null } : {}),
        name,
        description,
        keywords: keywords ?? [],
        valueProp: valueProp ?? null,
        ...(lifecyclePhase ? { lifecyclePhase } : {}),
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
      ...(lifecyclePhase ? { lifecyclePhase } : {}),
      seoAuditJson: seoAudit,
    });
  }

  // ── Trigger calibration if product identity changed ──
  // Compare against the values that were actually written to DB
  let finalName: string;
  let finalDesc: string;
  let finalKeywords: string[];
  let finalValueProp: string | null;

  if (prev && merge) {
    finalName = PLACEHOLDER_NAMES.includes(prev.name) ? name : prev.name;
    finalDesc = PLACEHOLDER_DESCS.includes(prev.description) ? description : prev.description;
    finalKeywords = [...new Set([...prev.keywords, ...(keywords ?? [])])];
    finalValueProp = prev.valueProp || valueProp || null;
  } else {
    finalName = name;
    finalDesc = description;
    finalKeywords = keywords ?? [];
    finalValueProp = valueProp ?? null;
  }

  const coreChanged =
    !prev ||
    prev.name !== finalName ||
    prev.description !== finalDesc ||
    prev.valueProp !== finalValueProp ||
    JSON.stringify([...prev.keywords].sort()) !==
      JSON.stringify([...finalKeywords].sort());

  if (coreChanged) {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.userId, session.user.id))
      .limit(1);

    if (product) {
      const userChannels = await db
        .select({ platform: channels.platform })
        .from(channels)
        .where(eq(channels.userId, session.user.id));

      const platforms = [
        ...new Set(userChannels.map((c) => c.platform)),
      ].filter(isPlatformAvailable);

      for (const platform of platforms) {
        // Reset calibration status so the loop runs fresh
        await db
          .insert(discoveryConfigs)
          .values({
            userId: session.user.id,
            platform,
            calibrationStatus: 'pending',
          })
          .onConflictDoUpdate({
            target: [discoveryConfigs.userId, discoveryConfigs.platform],
            set: {
              calibrationStatus: 'pending',
              calibrationRound: 0,
              calibrationPrecision: null,
              calibrationLog: null,
              updatedAt: new Date(),
            },
          });
      }

      if (platforms.length > 0) {
        await enqueueCalibration({
          userId: session.user.id,
          productId: product.id,
        });
        log.info(
          `Enqueued calibration for product ${product.id} (${prev ? 'updated' : 'new'}), platforms: ${platforms.join(', ')}`,
        );
      }
    }
  }

  return NextResponse.json({ success: true });
}
