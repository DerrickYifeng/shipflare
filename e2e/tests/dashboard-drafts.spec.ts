import { testWithProduct, expect } from '../fixtures/auth';
import {
  seedThreads,
  seedDrafts,
  seedHealthScore,
  seedActivityEvents,
} from '../fixtures/db';

testWithProduct.describe('Dashboard: draft review', () => {
  testWithProduct('reviews 3 drafts: approve 2, skip 1', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    // Seed test data
    const threads = await seedThreads(testUser.id, 3);
    const drafts = await seedDrafts(
      testUser.id,
      threads.map((t) => t.id),
    );
    await seedHealthScore(testUser.id, 72);
    await seedActivityEvents(testUser.id, 5);

    await page.goto('/dashboard');

    // Verify health score ring
    await expect(page.getByRole('img', { name: /Health score: 72/ })).toBeVisible();
    await expect(page.getByText('72')).toBeVisible();

    // Verify 3 draft cards visible
    const draftCards = page.locator('[class*="animate-sf-fade-in"]');
    await expect(draftCards).toHaveCount(3);

    // Verify first draft content
    const firstCard = draftCards.first();
    await expect(firstCard.getByText(/r\//)).toBeVisible();
    await expect(firstCard.getByText(/\d+%/)).toBeVisible();
    await expect(firstCard.getByText('Great question!')).toBeVisible();
    await expect(firstCard.getByText(/FTC:/)).toBeVisible();

    // Toggle "Why this works"
    await firstCard.getByText('Why this works').click();
    await expect(firstCard.getByText(/addresses the user/)).toBeVisible();

    // Approve first draft
    await firstCard.getByRole('button', { name: 'Send' }).click();
    await expect(draftCards).toHaveCount(2);

    // Skip second draft
    const secondCard = draftCards.first();
    await secondCard.getByRole('button', { name: 'Skip' }).click();
    await expect(draftCards).toHaveCount(1);

    // Approve third draft
    const thirdCard = draftCards.first();
    await thirdCard.getByRole('button', { name: 'Send' }).click();

    // Verify empty state
    await expect(page.getByText('No pending drafts')).toBeVisible();
  });

  testWithProduct('shows empty states when no data', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('No pending drafts')).toBeVisible();
    await expect(page.getByText('No threads discovered')).toBeVisible();
  });
});
