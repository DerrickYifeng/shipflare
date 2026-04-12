import type { Page } from '@playwright/test';

const MOCK_PROFILE = {
  url: 'https://shipflare.dev',
  name: 'ShipFlare',
  description: 'AI marketing autopilot for indie developers',
  keywords: ['marketing', 'reddit', 'seo', 'automation'],
  valueProp: 'Automates Reddit marketing so indie devs can focus on building.',
  ogImage: null,
  seoAudit: { score: 72, checks: [], recommendations: [] },
};

/**
 * Intercept POST /api/onboarding/extract with a successful mock response.
 * Avoids real URL scraping during tests.
 */
export async function mockExtractSuccess(page: Page) {
  await page.route('**/api/onboarding/extract', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_PROFILE),
    }),
  );
}

/**
 * Intercept POST /api/onboarding/extract with an error response.
 * Simulates a bad URL / scraping failure.
 */
export async function mockExtractFailure(page: Page) {
  await page.route('**/api/onboarding/extract', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Failed to extract profile from URL' }),
    }),
  );
}
