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

const CHANNELS_URL = '/api/reddit-channels';

beforeEach(() => {
  // Reset the channels key before each test so leakage doesn't pollute
  // results.
  swrMockState[CHANNELS_URL] = {};
});

afterEach(() => {
  // RTL's global `screen` queries the document — tear down rendered
  // DOM between tests so we don't pick up nodes from prior render().
  cleanup();
});

describe('<RedditResearchCard /> — error state', () => {
  it('shows a refresh hint when the channels fetch errors', () => {
    swrMockState[CHANNELS_URL] = { error: new Error('boom') };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /unable to load reddit communities/i }),
    ).toBeTruthy();
    expect(screen.getByText(/refresh the page to retry/i)).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — loading state', () => {
  it('renders a spinner while SWR is loading and has no data yet', () => {
    swrMockState[CHANNELS_URL] = { isLoading: true, data: undefined };

    render(<RedditResearchCard />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — empty state', () => {
  it('renders the "no subreddits yet" message and a Re-research button when channels is []', () => {
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };

    render(<RedditResearchCard />);
    expect(
      screen.getByRole('heading', { name: /your reddit communities/i }),
    ).toBeTruthy();
    expect(
      screen.getByText(/no reddit communities researched yet/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-research/i })).toBeTruthy();
  });
});

describe('<RedditResearchCard /> — done state', () => {
  it('renders all channel rows sorted active-first and the add-form', () => {
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

  it('POSTs to /api/reddit-channels/re-research and revalidates the channels SWR on click', async () => {
    const channelsMutate = vi.fn(async () => undefined);
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

      // Channels SWR revalidated so any new rows the worker writes
      // surface on the next read.
      expect(channelsMutate).toHaveBeenCalledTimes(1);

      // Inline hint tells the founder to refresh in 30–60s.
      // The fetch + setState chain spans a few microtasks; findByText
      // polls so we don't race the React commit.
      expect(
        await screen.findByText(/refresh in 30.{0,3}60s/i),
      ).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces an inline error when re-research POST fails', async () => {
    const channelsMutate = vi.fn(async () => undefined);
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
      expect(channelsMutate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
