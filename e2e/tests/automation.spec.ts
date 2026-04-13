import { testWithProduct, expect } from '../fixtures/auth';
import { mockEventSource, emitSSEEvent, emitSSESequence } from '../helpers/sse-mock';
import {
  mockAutomationRunSuccess,
  mockAutomationRunNoProduct,
  mockAutomationRunNetworkError,
} from '../helpers/intercepts';

testWithProduct.describe('Automation war room', () => {
  testWithProduct('shows empty state before first run', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await page.goto('/agents');

    // Page title from HeaderBar
    await expect(page.locator('h1', { hasText: 'Automation' })).toBeVisible();

    // Empty state
    await expect(page.getByText('Ready to launch')).toBeVisible();

    // Button should be enabled
    const runBtn = page.getByRole('button', { name: 'Run Automation' });
    await expect(runBtn).toBeEnabled();
  });

  testWithProduct('triggers automation and transitions through states', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await mockAutomationRunSuccess(page);
    await page.goto('/agents');

    await emitSSEEvent(page, { type: 'connected' });

    // Click Run Automation
    const runBtn = page.getByRole('button', { name: 'Run Automation' });
    await runBtn.click();

    // After the mock API resolves instantly, the button goes back to idle
    // until SSE events arrive. Emit agent_start to transition to "Running".
    await emitSSEEvent(page, {
      type: 'agent_start',
      agentName: 'scout',
      currentTask: 'Scanning communities...',
    });

    // Button should now show "Running" with pulsing dot
    await expect(page.getByRole('button', { name: 'Running' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Running' })).toBeDisabled();

    // Agent grid should appear — verify all 5 agent names
    await expect(page.getByText('SCOUT')).toBeVisible();
    await expect(page.getByText('DISCOVERY')).toBeVisible();
    await expect(page.getByText('CONTENT')).toBeVisible();
    await expect(page.getByText('REVIEW')).toBeVisible();
    await expect(page.getByText('POSTING')).toBeVisible();
  });

  testWithProduct('shows agent pipeline progression via SSE events', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await mockAutomationRunSuccess(page);
    await page.goto('/agents');

    await emitSSEEvent(page, { type: 'connected' });
    await page.getByRole('button', { name: 'Run Automation' }).click();

    // Scout starts
    await emitSSEEvent(page, {
      type: 'agent_start',
      agentName: 'scout',
      currentTask: 'Scanning communities...',
    });
    await expect(page.getByText('Scanning communities...')).toBeVisible();

    // Scout progresses — verify progress bar
    await emitSSEEvent(page, {
      type: 'agent_progress',
      agentName: 'scout',
      progress: 50,
      currentTask: 'Found 6 communities',
    });
    const progressBar = page.locator('div[role="progressbar"]').first();
    await expect(progressBar).toHaveAttribute('aria-valuenow', '50');
    await expect(page.getByText('Found 6 communities')).toBeVisible();

    // Scout completes with stats, cost, duration
    await emitSSEEvent(page, {
      type: 'agent_complete',
      agentName: 'scout',
      stats: { communities: 12 },
      cost: 0.003,
      duration: 8.5,
    });

    // Verify stats rendered in the Scout card
    // Use the stat label (uppercase mono) to avoid matching currentTask text
    const scoutCard = page.locator('[class*="animate-sf-fade-in"]').filter({
      has: page.getByText('SCOUT'),
    });
    await expect(scoutCard.getByText('12')).toBeVisible();
    await expect(scoutCard.locator('.uppercase', { hasText: 'communities' })).toBeVisible();
    await expect(scoutCard.getByText('$0.003')).toBeVisible();
    await expect(scoutCard.getByText('8.5s')).toBeVisible();

    // Scout progress bar should be at 100
    await expect(progressBar).toHaveAttribute('aria-valuenow', '100');

    // Discovery starts
    await emitSSEEvent(page, {
      type: 'agent_start',
      agentName: 'discovery',
      currentTask: 'Discovering threads...',
    });
    await expect(page.getByText('Discovering threads...')).toBeVisible();

    // Discovery completes
    await emitSSEEvent(page, {
      type: 'agent_complete',
      agentName: 'discovery',
      stats: { threads: 24 },
      cost: 0.012,
      duration: 15.3,
    });
    // Verify discovery stats in the Discovery card
    const discoveryCard = page.locator('[class*="animate-sf-fade-in"]').filter({
      has: page.getByText('DISCOVERY'),
    });
    await expect(discoveryCard.getByText('24')).toBeVisible();
    await expect(discoveryCard.locator('.uppercase', { hasText: 'threads' })).toBeVisible();
  });

  testWithProduct('agent card log expands and shows tool calls', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await mockAutomationRunSuccess(page);
    await page.goto('/agents');

    await emitSSEEvent(page, { type: 'connected' });
    await page.getByRole('button', { name: 'Run Automation' }).click();

    // Start scout and emit tool calls
    await emitSSEEvent(page, {
      type: 'agent_start',
      agentName: 'scout',
      currentTask: 'Scanning...',
    });

    await emitSSESequence(page, [
      { type: 'tool_call', agentName: 'scout', toolName: 'searchReddit', args: 'r/SaaS' },
      { type: 'tool_call', agentName: 'scout', toolName: 'searchReddit', args: 'r/webdev' },
      { type: 'tool_call', agentName: 'scout', toolName: 'analyzeSubreddit', args: 'r/startups' },
    ], 50);

    // LOG button should appear with count
    const logButton = page.getByRole('button', { name: /LOG \(3\)/ });
    await expect(logButton).toBeVisible();

    // Expand log
    await logButton.click();

    // Verify log entries
    await expect(page.getByText('searchReddit(r/SaaS)')).toBeVisible();
    await expect(page.getByText('searchReddit(r/webdev)')).toBeVisible();
    await expect(page.getByText('analyzeSubreddit(r/startups)')).toBeVisible();

    // Collapse log
    await logButton.click();
    await expect(page.getByText('searchReddit(r/SaaS)')).not.toBeVisible();
  });

  testWithProduct('shows error banner on network failure', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await mockAutomationRunNetworkError(page);
    await page.goto('/agents');

    await emitSSEEvent(page, { type: 'connected' });
    await page.getByRole('button', { name: 'Run Automation' }).click();

    // Error banner should appear
    await expect(page.getByText('Network error')).toBeVisible();

    // Button should return to idle state
    await expect(page.getByRole('button', { name: 'Run Automation' })).toBeEnabled();
  });

  testWithProduct('shows error banner when no product configured', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await mockEventSource(page);
    await mockAutomationRunNoProduct(page);
    await page.goto('/agents');

    await emitSSEEvent(page, { type: 'connected' });
    await page.getByRole('button', { name: 'Run Automation' }).click();

    // Error banner should show the "no product" message
    await expect(page.getByText('No product configured')).toBeVisible();

    // Button should return to idle
    await expect(page.getByRole('button', { name: 'Run Automation' })).toBeEnabled();
  });
});
