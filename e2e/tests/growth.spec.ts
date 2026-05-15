import { testWithProduct, expect } from '../fixtures/auth';
import { seedChannel } from '../fixtures/db';

testWithProduct.describe('Growth page', () => {
  testWithProduct('renders hero, module strip, and channel cards', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/growth');

    // Header
    await expect(page.locator('h1', { hasText: 'Growth' })).toBeVisible();

    // Hero — "ShipFlare health" label sits under the dial
    await expect(page.getByText('ShipFlare health')).toBeVisible();

    // Module strip — 5 chips by testid
    await expect(page.getByTestId('module-chip-social')).toBeVisible();
    await expect(page.getByTestId('module-chip-search')).toBeVisible();
    await expect(page.getByTestId('module-chip-performance')).toBeVisible();
    await expect(page.getByTestId('module-chip-content')).toBeVisible();
    await expect(page.getByTestId('module-chip-analytics')).toBeVisible();

    // Social panel header (the "·" between manager name and score is
    // a typographic middle dot, so match via partial text).
    await expect(
      page.getByText('Social Media Manager', { exact: false }),
    ).toBeVisible();

    // Both channel cards
    await expect(page.getByTestId('channel-card-x')).toBeVisible();
    await expect(page.getByTestId('channel-card-reddit')).toBeVisible();
  });

  testWithProduct('"Manage subreddits →" navigates to /growth/reddit-channels', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    // SubredditChips (the "Manage subreddits →" link) only renders when the
    // Reddit card is in the CONNECTED branch. The fixture seeds the user +
    // product but no channels, so we seed a Reddit channel here to flip the
    // card into its connected state. Default platform for `seedChannel` is
    // 'reddit', so no override needed.
    await seedChannel(testUser.id);

    await page.goto('/growth');
    const link = page.getByRole('link', { name: /Manage subreddits/ });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL('**/growth/reddit-channels');
    await expect(
      page.locator('h1', { hasText: 'Reddit communities' }),
    ).toBeVisible();
  });

  testWithProduct('Settings no longer shows a Reddit row', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

    // Navigate to the Integrations tab — that's where channel tiles live.
    await page.getByRole('button', { name: 'Integrations' }).click();

    // The X tile should still be there.
    await expect(page.getByText('X / Twitter')).toBeVisible();

    // No Reddit integration tile anywhere on the page. We assert on the
    // exact integration-name string used by the X tile so we don't false-
    // positive on incidental copy elsewhere.
    await expect(page.getByText('Reddit', { exact: true })).toHaveCount(0);
  });
});
