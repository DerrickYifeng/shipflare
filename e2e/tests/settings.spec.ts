import { testWithProduct, expect } from '../fixtures/auth';

testWithProduct.describe('Settings', () => {
  testWithProduct('displays profile and connection status', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    await page.goto('/settings');

    // Verify heading
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Verify profile section
    await expect(page.getByText(testUser.name)).toBeVisible();
    await expect(page.getByText(testUser.email)).toBeVisible();

    // X is not connected by default; Connect button should be visible.
    await expect(page.getByText('X / Twitter')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();

    // Reddit row no longer lives in Settings — moved to /growth/reddit-channels
    // (covered by e2e/tests/growth.spec.ts "Settings no longer shows a Reddit row").

    // Verify danger zone
    await expect(page.getByText('Danger zone')).toBeVisible();
  });

  // Account deletion endpoint is not yet implemented post-CF migration.
  // The dialog opens and the "DELETE" gate works, but clicking confirm shows
  // an unavailable-feature toast instead of completing deletion.
  // Re-enable the full happy-path assertion when /api/account ships.
  testWithProduct('deletes account with DELETE confirmation', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');

    // Open delete dialog
    await page.getByRole('button', { name: 'Delete account' }).click();

    // Verify dialog
    await expect(page.getByText('Type DELETE to confirm', { exact: false })).toBeVisible();

    // Button should be disabled
    const deleteBtn = page.getByRole('button', { name: 'Delete permanently' });
    await expect(deleteBtn).toBeDisabled();

    // Type DELETE to enable
    await page.getByPlaceholder('Type DELETE').fill('DELETE');
    await expect(deleteBtn).toBeEnabled();

    // Click delete — surfaces "not yet available" toast during beta.
    await deleteBtn.click();
    await expect(page.getByText(/not yet available/i)).toBeVisible();
    // Still on /settings (no redirect because the route doesn't exist yet).
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  testWithProduct('cancels deletion dialog', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');

    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByText('Type DELETE to confirm', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();

    // Dialog should be closed, still on settings
    await expect(page.getByText('Type DELETE to confirm', { exact: false })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  testWithProduct('navigates between dashboard and settings', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // Navigate to settings via sidebar
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Navigate back to dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
