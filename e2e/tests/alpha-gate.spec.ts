import { test, expect } from '@playwright/test';

// These tests exercise the public-facing waitlist flow without
// requiring real GitHub OAuth. They cover:
//   1. Anonymous user hits /waitlist directly → form renders
//   2. Submitting the form → success card
//   3. Pre-fill from ?email= → input value matches
//   4. Landing CTA → /waitlist (no GitHub roundtrip needed)
//
// The full "GitHub-denied → /waitlist redirect → admin approves →
// re-signin succeeds" loop is covered by a manual smoke run
// documented in the plan task 11 step 4 — automating mock OAuth in
// Playwright is out of scope for v1.

test.describe('Alpha gate — waitlist flow', () => {
  test('landing primary CTA links to /waitlist', async ({ page }) => {
    await page.goto('/');
    const requestAccess = page.getByRole('link', { name: /request alpha access/i }).first();
    await expect(requestAccess).toBeVisible();
    await requestAccess.click();
    await expect(page).toHaveURL(/\/waitlist/);
  });

  test('waitlist page renders the "landing" banner when no query params', async ({ page }) => {
    await page.goto('/waitlist');
    await expect(page.getByRole('heading', { name: /private alpha/i })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeEmpty();
  });

  test('waitlist page pre-fills email and shows "denied" banner from query params', async ({ page }) => {
    await page.goto('/waitlist?from=denied&email=test%40example.com');
    await expect(
      page.getByRole('heading', { name: /isn't on the alpha list/i }),
    ).toBeVisible();
    await expect(page.locator('input[name="email"]')).toHaveValue('test@example.com');
  });

  test('submitting the form shows the success card', async ({ page }) => {
    const email = `e2e-${Date.now()}@example.com`;
    await page.goto('/waitlist');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('textarea[name="useCase"]').fill('e2e smoke');
    await page.getByRole('button', { name: /request access/i }).click();
    await expect(page.getByRole('heading', { name: /you're on the list/i })).toBeVisible();
  });

  test('invalid email surfaces a friendly error and form stays editable', async ({ page }) => {
    await page.goto('/waitlist');
    await page.locator('input[name="email"]').fill('not-an-email');
    // browser-side type=email validation will block submission; bypass by
    // setting the input attribute then submitting
    await page.locator('input[name="email"]').evaluate((el: HTMLInputElement) => {
      el.removeAttribute('required');
      el.setAttribute('type', 'text');
    });
    await page.getByRole('button', { name: /request access/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
