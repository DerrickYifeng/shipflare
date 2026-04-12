import { test, expect } from '../fixtures/auth';
import { mockExtractFailure } from '../helpers/intercepts';

test.describe('Onboarding: bad URL fallback', () => {
  test('shows error on bad URL, manual entry completes onboarding', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractFailure(page);
    await page.goto('/onboarding');

    // Enter bad URL and try to extract
    await page.getByPlaceholder('https://your-product.com').fill('https://bad-url.invalid');
    await page.getByRole('button', { name: 'Extract profile' }).click();

    // Verify error message appears
    await expect(page.getByText('Failed to extract profile from URL')).toBeVisible();

    // Switch to manual entry
    await page.getByRole('button', { name: 'Enter manually' }).click();

    // Step 1: Review with empty fields
    await expect(page.getByRole('heading', { name: 'Review your profile' })).toBeVisible();

    // Fill in required fields
    await page.getByLabel('Product name').fill('My Test Product');
    await page.locator('textarea').fill('A test product for E2E testing');
    await page.getByLabel('Keywords').fill('testing, e2e, playwright');
    await page.getByLabel('Value proposition').fill('Makes testing easy');

    // Save and continue
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 2: Connect Reddit
    await expect(page.getByRole('heading', { name: 'Connect Reddit' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();

    // Redirected to dashboard
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
