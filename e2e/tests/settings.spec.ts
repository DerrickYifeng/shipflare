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

  // Verifies the delete dialog opens and the typed-DELETE gate works.
  // We DO NOT actually click "Delete permanently" in CI — that would destroy
  // the shared test user. The full end-to-end flow (redirect to /) is covered
  // by the unit tests in apps/web/test/api-account.test.ts.
  testWithProduct('settings account deletion dialog opens with typed-DELETE gate', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');

    // Open delete dialog
    await page.getByRole('button', { name: 'Delete account' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Verify dialog content
    await expect(page.getByText('Type DELETE to confirm', { exact: false })).toBeVisible();

    // Button should be disabled until "DELETE" is typed
    const deleteBtn = page.getByRole('button', { name: 'Delete permanently' });
    await expect(deleteBtn).toBeDisabled();

    // Type DELETE to enable the button
    await page.getByPlaceholder('Type DELETE').fill('DELETE');
    await expect(deleteBtn).toBeEnabled();

    // DO NOT actually click delete in CI — would destroy the test user.
    // The full happy-path (D1 deletion + redirect to /) is covered by
    // unit tests on /api/account in apps/web/test/api-account.test.ts.
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
