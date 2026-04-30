/**
 * Smoke test for src/services/web-scraper.ts after engine-style hardening.
 * Run: pnpm tsx scripts/scrape-smoke.ts
 *
 * Tests: status mapping, http→https upgrade, redirect detection, markdown
 * length on real public landing pages.
 */
import { scrapeWebsite } from '../src/services/web-scraper';

const URLS = [
  'https://example.com',
  'https://stripe.com',
  'https://vercel.com',
  'https://linear.app',
  'https://posthog.com',
  'https://shipflare.dev',
  'http://anthropic.com',
];

async function main() {
  for (const url of URLS) {
    const t0 = Date.now();
    const result = await scrapeWebsite(url);
    const ms = Date.now() - t0;
    const md = result.pageMarkdown;
    const sample = JSON.stringify(md.slice(0, 120)).slice(0, 140);
    console.log(
      [
        `URL: ${url}`,
        `  status: ${result.status}${result.error ? ` (${result.error})` : ''}`,
        `  duration: ${ms}ms`,
        `  title: ${result.title.slice(0, 80)}`,
        `  description: ${result.description.slice(0, 80)}`,
        `  ogImage: ${result.ogImage ?? '(none)'}`,
        `  redirectUrl: ${result.redirectUrl ?? '(none)'}`,
        `  markdown: ${md.length} chars (sample: ${sample})`,
      ].join('\n'),
    );
    console.log();
  }
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
