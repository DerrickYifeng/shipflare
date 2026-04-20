import { test, expect } from '@playwright/test';

test.describe('SignInModal (unauthenticated)', () => {
  test('top-nav Sign up opens the provider modal', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Sign in to ShipFlare' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  });

  test('Esc closes the modal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('× button closes the modal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Continue with GitHub navigates to GitHub OAuth', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    // Intercept the OAuth redirect before the browser follows it
    const requestPromise = page.waitForRequest((request) =>
      request.url().startsWith('https://github.com/login/oauth/authorize'),
    );

    await page.getByRole('button', { name: 'Continue with GitHub' }).click();

    const request = await requestPromise;
    expect(request.url()).toContain('client_id=');
  });
});
