import { test, expect } from '../fixtures/auth';
import { testWithProduct } from '../fixtures/auth';
import { mockExtractSuccess } from '../helpers/intercepts';

test.describe('Onboarding: complete flow', () => {
  test('completes full onboarding: extract → review → skip Reddit → dashboard', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await page.goto('/onboarding');

    // Step 0: URL input
    await expect(page.getByRole('heading', { name: 'Add your product' })).toBeVisible();

    // Fill URL and extract
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: 'Extract profile' }).click();

    // Step 1: Review profile (pre-filled from mock)
    await expect(page.getByRole('heading', { name: 'Review your profile' })).toBeVisible();
    await expect(page.getByLabel('Product name')).toHaveValue('ShipFlare');
    await expect(page.locator('textarea')).toContainText('AI marketing autopilot');

    // Save profile (hits real API, auditSeo returns score: 0 gracefully)
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 2: Connect Reddit
    await expect(page.getByRole('heading', { name: 'Connect Reddit' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();

    // Redirected to dashboard
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('redirects authed user without product to /onboarding from /dashboard', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/dashboard');
    await page.waitForURL('**/onboarding');
    await expect(page.getByRole('heading', { name: 'Add your product' })).toBeVisible();
  });
});

testWithProduct.describe('Onboarding: redirect with product', () => {
  testWithProduct('redirects authed user with product to /dashboard from /', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/');
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
