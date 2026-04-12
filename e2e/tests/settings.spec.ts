import { testWithProduct, expect } from '../fixtures/auth';
import { seedChannel } from '../fixtures/db';

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

    // Verify Reddit not connected
    await expect(page.getByText('Reddit')).toBeVisible();
    await expect(page.getByText('Not connected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();

    // Verify danger zone
    await expect(page.getByText('Danger zone')).toBeVisible();
  });

  testWithProduct('shows connected Reddit when channel exists', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    await seedChannel(testUser.id, { username: 'testreddituser' });
    await page.goto('/settings');

    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByText('u/testreddituser')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

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

    // Click delete
    await deleteBtn.click();

    // Should redirect to sign-in page
    await page.waitForURL('/');
    await expect(page.getByText('ShipFlare')).toBeVisible();
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
