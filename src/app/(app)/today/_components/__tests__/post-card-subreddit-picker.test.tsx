// @vitest-environment jsdom
//
// PostCard subreddit-picker safety net tests.
//
// Scenario: a Reddit `content_post` plan_item lands in /today without
// `params.subreddit` (legacy row, or a future bug in the research
// pipeline). The Post button would crash `dispatchApprove` server-side
// — instead the card swaps to an inline subreddit picker fed by
// `GET /api/reddit-channels`, and Apply PATCHes
// `/api/today/[id]/edit { params: { subreddit }}`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// ── Mock SWR so we control /api/reddit-channels per-test ───────────────
const swrMockState: Record<
  string,
  {
    data?: unknown;
    error?: unknown;
    isLoading?: boolean;
  }
> = {};

vi.mock('swr', () => ({
  default: (key: string) => {
    const entry = swrMockState[key] ?? {};
    return {
      data: entry.data,
      error: entry.error,
      isLoading: entry.isLoading ?? false,
      mutate: async () => undefined,
    };
  },
}));

import { PostCard } from '../post-card';
import type { TodoItem } from '@/hooks/use-today';

const CHANNELS_URL = '/api/reddit-channels';

function makeItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'item-1',
    draftId: null,
    todoType: 'approve_post',
    source: 'calendar',
    priority: 'scheduled',
    status: 'pending',
    planState: 'drafted',
    xIntentUrl: null,
    title: 'Test post',
    platform: 'reddit',
    community: null,
    externalUrl: null,
    confidence: null,
    expiresAt: '2026-05-12',
    createdAt: new Date().toISOString(),
    draftBody: 'A drafted body.',
    draftConfidence: null,
    draftWhyItWorks: null,
    draftType: 'original_post',
    draftPostTitle: null,
    draftMedia: null,
    threadTitle: null,
    threadBody: null,
    threadAuthor: null,
    threadUrl: null,
    threadUpvotes: null,
    threadCommentCount: null,
    threadPostedAt: null,
    threadDiscoveredAt: null,
    threadLikesCount: null,
    threadRepostsCount: null,
    threadRepliesCount: null,
    threadViewsCount: null,
    threadIsRepost: false,
    threadOriginalUrl: null,
    threadOriginalAuthorUsername: null,
    threadSurfacedVia: null,
    calendarContentType: 'content_post',
    params: null,
    cardFormat: 'post',
    ...overrides,
  };
}

beforeEach(() => {
  swrMockState[CHANNELS_URL] = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── needsSubreddit gate ────────────────────────────────────────────────

describe('PostCard — needsSubreddit detection', () => {
  it('renders the Post button (no picker) for X content_post', () => {
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };
    const onApprove = vi.fn();
    render(
      <PostCard
        item={makeItem({ platform: 'x' })}
        onApprove={onApprove}
        onSkip={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /post/i })).toBeTruthy();
    expect(screen.queryByLabelText(/choose a subreddit/i)).toBeNull();
  });

  it('renders the Post button for Reddit content_post WITH subreddit set', () => {
    swrMockState[CHANNELS_URL] = { data: { channels: [] } };
    render(
      <PostCard
        item={makeItem({
          platform: 'reddit',
          calendarContentType: 'content_post',
          params: { subreddit: 'SaaS' },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /post/i })).toBeTruthy();
    expect(screen.queryByLabelText(/choose a subreddit/i)).toBeNull();
  });

  it('renders the picker for Reddit content_post WITHOUT subreddit', () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          {
            id: 'r1',
            subreddit: 'SaaS',
            rank: 1,
            fitScore: 0.8,
            disabled: false,
            source: 'auto',
          },
        ],
      },
    };
    render(
      <PostCard
        item={makeItem({
          platform: 'reddit',
          calendarContentType: 'content_post',
          params: null,
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/choose a subreddit/i)).toBeTruthy();
    // Picker replaces the Post button — there is exactly one Apply button.
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^post$/i })).toBeNull();
  });

  it('also treats empty-string subreddit as needsSubreddit', () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.8, disabled: false, source: 'auto' },
        ],
      },
    };
    render(
      <PostCard
        item={makeItem({
          platform: 'reddit',
          calendarContentType: 'content_post',
          params: { subreddit: '' },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/choose a subreddit/i)).toBeTruthy();
  });
});

// ── Picker behavior ────────────────────────────────────────────────────

describe('PostCard — SubredditPicker behavior', () => {
  function renderPicker(overrides?: Partial<TodoItem>) {
    return render(
      <PostCard
        item={makeItem({
          platform: 'reddit',
          calendarContentType: 'content_post',
          params: null,
          ...overrides,
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onEdit={() => {}}
      />,
    );
  }

  it('filters out disabled subreddits from the dropdown', () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.8, disabled: false, source: 'auto' },
          { id: 'r2', subreddit: 'banished', rank: 2, fitScore: 0.5, disabled: true, source: 'auto' },
          { id: 'r3', subreddit: 'startups', rank: 3, fitScore: 0.7, disabled: false, source: 'auto' },
        ],
      },
    };
    renderPicker();
    const select = screen.getByLabelText(/choose a subreddit/i) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('r/SaaS');
    expect(optionLabels).toContain('r/startups');
    expect(optionLabels).not.toContain('r/banished');
  });

  it('defaults selected to the rank-1 active subreddit', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r3', subreddit: 'startups', rank: 3, fitScore: 0.5, disabled: false, source: 'auto' },
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    renderPicker();
    const select = screen.getByLabelText(/choose a subreddit/i) as HTMLSelectElement;
    // Effect that defaults `selected` runs after first paint; wait for it.
    await waitFor(() => {
      expect(select.value).toBe('SaaS');
    });
  });

  it('PATCHes /api/today/[id]/edit with { params: { subreddit } } and calls onApplied on 200', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApplied = vi.fn();

    render(
      <PostCard
        item={makeItem({
          id: 'item-zzz',
          platform: 'reddit',
          calendarContentType: 'content_post',
          params: null,
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onEdit={() => {}}
        onSubredditApplied={onApplied}
      />,
    );

    // Wait for the default-select effect to populate `value`.
    await waitFor(() => {
      const sel = screen.getByLabelText(/choose a subreddit/i) as HTMLSelectElement;
      expect(sel.value).toBe('SaaS');
    });

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('/api/today/item-zzz/edit');
    expect(calledInit?.method).toBe('PATCH');
    const payload = JSON.parse((calledInit?.body as string) ?? '{}');
    expect(payload).toEqual({ params: { subreddit: 'SaaS' } });
  });

  it('renders an inline error message on non-2xx and does NOT call onApplied', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ error: 'kaboom' }), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApplied = vi.fn();

    renderPicker();
    await waitFor(() => {
      const sel = screen.getByLabelText(/choose a subreddit/i) as HTMLSelectElement;
      expect(sel.value).toBe('SaaS');
    });

    // No onSubredditApplied wired through to confirm it never fires.
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/kaboom|Couldn/);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('shows a loading placeholder while the channels request is in flight', () => {
    swrMockState[CHANNELS_URL] = { isLoading: true };
    renderPicker();
    expect(screen.getByRole('status', { name: /loading communities/i })).toBeTruthy();
  });

  it('shows an inline error when the channels fetch errors', () => {
    swrMockState[CHANNELS_URL] = { error: new Error('boom') };
    renderPicker();
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t load communities/i);
  });

  it('+ add another reveals an input, validates regex, and rejects invalid manual values', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /add another/i }));

    const input = screen.getByLabelText(/add a subreddit/i) as HTMLInputElement;
    // Bad: contains 'r/' prefix
    fireEvent.change(input, { target: { value: 'r/SaaS' } });
    // Apply button should be disabled
    const applyBtn = screen.getByRole('button', { name: /apply/i }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    // Inline regex hint surfaces
    expect(
      screen.getAllByRole('alert').some((el) => /3-21 chars/.test(el.textContent ?? '')),
    ).toBe(true);

    // Good: valid name → Apply enabled and triggers a PATCH
    fireEvent.change(input, { target: { value: 'webdev' } });
    expect((screen.getByRole('button', { name: /apply/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit | undefined)?.body as string,
    );
    expect(payload).toEqual({ params: { subreddit: 'webdev' } });
  });

  it('moves keyboard focus to the manual input when "+ add another" is clicked', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /add another/i }));

    // The manual input should now have focus so keyboard users can
    // start typing immediately.
    const input = screen.getByLabelText(/add a subreddit/i) as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('returns keyboard focus to the dropdown when "Pick from list" is clicked', async () => {
    swrMockState[CHANNELS_URL] = {
      data: {
        channels: [
          { id: 'r1', subreddit: 'SaaS', rank: 1, fitScore: 0.9, disabled: false, source: 'auto' },
        ],
      },
    };
    renderPicker();

    // Flip into manual mode then back.
    fireEvent.click(screen.getByRole('button', { name: /add another/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/add a subreddit/i)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /pick from list/i }));

    const select = (await screen.findByLabelText(
      /choose a subreddit/i,
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(select);
    });
  });
});
