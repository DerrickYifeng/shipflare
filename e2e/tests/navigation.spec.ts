import { testWithProduct, expect } from '../fixtures/auth';

testWithProduct.describe('Navigation: sidebar', () => {
  testWithProduct('navigates between all three pages via sidebar', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible();

    // Dashboard → Automation
    await page.getByRole('link', { name: 'Automation' }).click();
    await page.waitForURL('**/agents');
    await expect(page.locator('h1', { hasText: 'Automation' })).toBeVisible();

    // Automation → Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

    // Settings → Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible();
  });

  testWithProduct('highlights active sidebar link', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const dashboardLink = nav.getByRole('link', { name: 'Dashboard' });
    const automationLink = nav.getByRole('link', { name: 'Automation' });

    // Active link does NOT have text-sf-text-secondary; inactive link does
    await expect(dashboardLink).not.toHaveClass(/text-sf-text-secondary/);
    await expect(automationLink).toHaveClass(/text-sf-text-secondary/);

    // Navigate to Automation
    await automationLink.click();
    await page.waitForURL('**/agents');

    // Now Automation should be active, Dashboard should not
    await expect(automationLink).not.toHaveClass(/text-sf-text-secondary/);
    await expect(dashboardLink).toHaveClass(/text-sf-text-secondary/);
  });

  testWithProduct('sign out redirects to landing page', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.waitForURL('/');
    await expect(page.getByText('ShipFlare')).toBeVisible();
  });

  testWithProduct('logo in sidebar links to dashboard', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();

    // Click the ShipFlare logo/text in the sidebar
    await page.locator('aside').getByRole('link', { name: 'ShipFlare' }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible();
  });
});
