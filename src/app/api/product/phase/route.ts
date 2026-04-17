import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { ProductLifecyclePhase } from '@/types/onboarding';

const VALID_PHASES: ProductLifecyclePhase[] = ['pre_launch', 'launched', 'scaling'];

/**
 * PUT /api/product/phase
 * Update the product lifecycle phase.
 */
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { lifecyclePhase?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { lifecyclePhase } = body;

  if (!lifecyclePhase || !VALID_PHASES.includes(lifecyclePhase as ProductLifecyclePhase)) {
    return NextResponse.json(
      { error: `Invalid phase. Must be one of: ${VALID_PHASES.join(', ')}` },
      { status: 400 },
    );
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product found. Complete onboarding first.' },
      { status: 404 },
    );
  }

  await db
    .update(products)
    .set({ lifecyclePhase, updatedAt: new Date() })
    .where(eq(products.id, product.id));

  return NextResponse.json({ success: true, lifecyclePhase });
}
