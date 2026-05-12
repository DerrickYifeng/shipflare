// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Mock SWR before importing the component so the component picks up the
// mock at evaluate-time. We control which mocked dataset gets returned
// per useSWR call via a small dispatch table keyed on the URL.
const swrMockState: Record<
  string,
  {
    data?: unknown;
    error?: unknown;
    isLoading?: boolean;
    mutate?: () => Promise<unknown>;
  }
> = {};

vi.mock('swr', () => ({
  default: (key: string) => {
    const entry = swrMockState[key] ?? {};
    return {
      data: entry.data,
      error: entry.error,
      isLoading: entry.isLoading ?? false,
      mutate: entry.mutate ?? (async () => undefined),
    };
  },
}));

import { RedditResearchCard } from '../reddit-research-card';

const STATUS_URL = '/api/onboarding/reddit-research/status';
const CHANNELS_URL = '/api/reddit-channels';

beforeEach(() => {
  // Reset both keys before each test so leakage doesn't pollute results.
  swrMockState[STATUS_URL] = {};
  swrMockState[CHANNELS_URL] = {};
});

afterEach(() => {
  // RTL's global `screen` queries the document — tear down rendered
  // DOM between tests so we don't pick up nodes from prior render().
  cleanup();
});

describe('<RedditResearchCard /> — error state', () => {
  it('shows a refresh hint when the status fetch errors', () => {
    swrMockState[STATUS_URL] = { error: new Error('boom') };
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /unable to load reddit communities/i }),
    ).toBeTruthy();
    expect(screen.getByText(/refresh the page to retry/i)).toBeTruthy();
  });

  it('shows the same hint when the channels fetch errors', () => {
    swrMockState[STATUS_URL] = { data: { status: 'pending', count: 0 } };
    swrMockState[CHANNELS_URL] = { error: new Error('boom') };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /unable to load reddit communities/i }),
    ).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — pending state', () => {
  it('renders a spinner and reassurance copy', () => {
    swrMockState[STATUS_URL] = { data: { status: 'pending', count: 0 } };
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /researching your reddit communities/i }),
    ).toBeTruthy();
    expect(screen.getByRole('status', { name: /loading/i })).toBeTruthy();
    // Reassurance hint about ≤60s
    expect(screen.getByText(/under 60 seconds/i)).toBeTruthy();
  });

  it('defaults to pending when status data is missing', () => {
    swrMockState[STATUS_URL] = { data: undefined };
    swrMockState[CHANNELS_URL] = { data: undefined };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /researching your reddit communities/i }),
    ).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — failed state', () => {
  it('renders the error heading and a retry CTA', () => {
    swrMockState[STATUS_URL] = { data: { status: 'failed', count: 0 } };
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /couldn.t finish researching reddit/i }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — done state', () => {
  it('renders all channel rows sorted active-first and the add-form', () => {
    swrMockState[STATUS_URL] = { data: { status: 'done', count: 2 } };
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          {
            id: 'r1',
            subreddit: 'SaaS',
            memberCount: 12_345,
            fitScore: 0.82,
            rulesSummary: 'No self-promo on Sundays.',
            activity: { postsLast7d: 50, commentsLast7d: 200 },
            rank: 1,
            source: 'auto',
            disabled: false,
          },
          {
            id: 'r2',
            subreddit: 'startups',
            memberCount: 2_000_000,
            fitScore: 0.41,
            rulesSummary: null,
            activity: null,
            rank: 2,
            source: 'auto',
            disabled: true, // should sort last
          },
          {
            id: 'r3',
            subreddit: 'indiehackers',
            memberCount: null,
            fitScore: null,
            rulesSummary: null,
            activity: { postsLast7d: 12 },
            rank: 3,
            source: 'manual',
            disabled: false,
          },
        ],
      },
    };

    const { container } = render(<RedditResearchCard />);

    // Heading
    expect(
      screen.getByRole('heading', { name: /your reddit communities/i }),
    ).toBeTruthy();
    // Re-research button
    expect(screen.getByRole('button', { name: /re-research/i })).toBeTruthy();

    // Subreddit names render with r/ prefix
    expect(screen.getByText('r/SaaS')).toBeTruthy();
    expect(screen.getByText('r/startups')).toBeTruthy();
    expect(screen.getByText('r/indiehackers')).toBeTruthy();

    // Add-form
    expect(screen.getByLabelText(/add another subreddit/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeTruthy();

    // Active rows come before disabled in the rendered DOM
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(3);
    // First two items are active, third is the disabled one
    expect(items[0].textContent).toContain('SaaS');
    expect(items[2].textContent).toContain('startups');
  });

  it('renders an empty-state hint when channels is []', () => {
    swrMockState[STATUS_URL] = { data: { status: 'done', count: 0 } };
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };

    render(<RedditResearchCard />);
    expect(screen.getByText(/no subreddits yet/i)).toBeTruthy();
  });

  it('POSTs to /api/reddit-channels/re-research and revalidates both SWR hooks on click', async () => {
    const statusMutate = vi.fn(async () => undefined);
    const channelsMutate = vi.fn(async () => undefined);
    swrMockState[STATUS_URL] = {
      data: { status: 'done', count: 0 },
      mutate: statusMutate,
    };
    swrMockState[CHANNELS_URL] = {
      data: { channels: [] },
      mutate: channelsMutate,
    };

    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      render(<RedditResearchCard />);
      const btn = screen.getByRole('button', { name: /re-research/i });
      fireEvent.click(btn);
      // Let the in-flight promise chain settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Asserted POST shape: correct URL + method, no body.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe('/api/reddit-channels/re-research');
      expect(calledInit?.method).toBe('POST');

      // Both SWR hooks revalidated so the UI flips back to 'pending'
      // once the worker writes new rows.
      expect(statusMutate).toHaveBeenCalledTimes(1);
      expect(channelsMutate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces an inline error when re-research POST fails', async () => {
    const statusMutate = vi.fn(async () => undefined);
    const channelsMutate = vi.fn(async () => undefined);
    swrMockState[STATUS_URL] = {
      data: { status: 'done', count: 0 },
      mutate: statusMutate,
    };
    swrMockState[CHANNELS_URL] = {
      data: { channels: [] },
      mutate: channelsMutate,
    };

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      render(<RedditResearchCard />);
      fireEvent.click(screen.getByRole('button', { name: /re-research/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The failure surfaced as an inline alert near the button.
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/HTTP 500/);
      // Revalidation did NOT fire (we short-circuit on !r.ok).
      expect(statusMutate).not.toHaveBeenCalled();
      expect(channelsMutate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
