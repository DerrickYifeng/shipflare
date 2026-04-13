import { testWithProduct, expect } from '../fixtures/auth';
import { seedThreads } from '../fixtures/db';

testWithProduct.describe('Discovery feed', () => {
  testWithProduct('shows empty state when no threads exist', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('No threads discovered')).toBeVisible();
    await expect(
      page.getByText('Run a discovery scan to find relevant Reddit threads'),
    ).toBeVisible();
  });

  testWithProduct('displays seeded threads with relevance badges', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    await seedThreads(testUser.id, 5);
    await page.goto('/dashboard');

    // Verify Discovery section heading
    await expect(page.getByText('Discovery').first()).toBeVisible();

    // Verify thread titles are visible (from seed-data.ts makeThread)
    await expect(page.getByText('How do you handle SEO')).toBeVisible();
    await expect(page.getByText('How do you handle marketing')).toBeVisible();

    // Verify subreddit labels
    await expect(page.getByText('r/webdev')).toBeVisible();
    await expect(page.getByText('r/SaaS')).toBeVisible();

    // Verify relevance score badges are present
    // makeThread formula: relevanceScore = 0.6 + (index % 4) * 0.1
    // index 0 → 60, index 1 → 70, index 2 → 80, index 3 → 90, index 4 → 60
    await expect(page.getByText('60').first()).toBeVisible();
    await expect(page.getByText('70')).toBeVisible();
  });

  testWithProduct('thread links have correct attributes', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    await seedThreads(testUser.id, 1);
    await page.goto('/dashboard');

    const threadLink = page.locator('a[href*="reddit.com"]').first();
    await expect(threadLink).toBeVisible();
    await expect(threadLink).toHaveAttribute('target', '_blank');
    await expect(threadLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
