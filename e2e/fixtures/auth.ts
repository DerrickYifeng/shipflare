import { test as base, type Page } from '@playwright/test';
import {
  seedUser,
  seedSession,
  seedProduct,
  cleanupUser,
} from './db';

interface AuthFixtures {
  authenticatedPage: Page;
  testUser: { id: string; name: string; email: string };
}

interface AuthWithProductFixtures {
  authenticatedPageWithProduct: Page;
  testUser: { id: string; name: string; email: string };
}

/**
 * Fixture: authenticated user WITHOUT a product (for onboarding tests).
 */
export const test = base.extend<AuthFixtures>({
  testUser: async ({}, use) => {
    const user = await seedUser();
    await use(user);
    await cleanupUser(user.id);
  },

  authenticatedPage: async ({ page, testUser }, use) => {
    const sessionToken = await seedSession(testUser.id);

    await page.context().addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await use(page);
  },
});

/**
 * Fixture: authenticated user WITH a product (for dashboard/settings tests).
 */
export const testWithProduct = base.extend<AuthWithProductFixtures>({
  testUser: async ({}, use) => {
    const user = await seedUser();
    await seedProduct(user.id);
    await use(user);
    await cleanupUser(user.id);
  },

  authenticatedPageWithProduct: async ({ page, testUser }, use) => {
    const sessionToken = await seedSession(testUser.id);

    await page.context().addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await use(page);
  },
});

export { expect } from '@playwright/test';
