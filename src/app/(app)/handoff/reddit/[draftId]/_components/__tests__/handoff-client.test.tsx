// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { HandoffClient } from '../handoff-client';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  globalThis.window.open = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseProps = {
  draftId: 'd-1',
  replyText: 'Tried this myself, it worked.',
  threadUrl: 'https://www.reddit.com/r/SaaS/comments/1abc234/test',
  threadTitle: 'How do I market',
  subreddit: 'SaaS',
  author: 'foo',
  alreadyHandedOff: false,
};

describe('HandoffClient', () => {
  it('attempts auto-copy on mount', async () => {
    render(<HandoffClient {...baseProps} />);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseProps.replyText);
    });
  });

  it('shows ✓ Copied after auto-copy succeeds', async () => {
    render(<HandoffClient {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
  });

  it('writes clipboard before opening the window when Open Reddit is clicked', async () => {
    const order: string[] = [];
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push('clipboard');
      },
    );
    (window.open as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('window-open');
      return null;
    });

    render(<HandoffClient {...baseProps} />);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /open reddit/i }));

    await waitFor(() => {
      expect(order).toEqual(['clipboard', 'clipboard', 'window-open']);
    });
  });

  it('POSTs to handoff-confirm endpoint on Open click', async () => {
    render(<HandoffClient {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /open reddit/i }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/draft/d-1/handoff-confirm',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('POSTs to handoff-confirm on Copy click', async () => {
    render(<HandoffClient {...baseProps} />);
    // Wait for auto-copy effect to settle so the Copy click is the
    // one we assert against fetch.
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole('button', { name: /copied|copy reply/i }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/draft/d-1/handoff-confirm',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows error message when clipboard is blocked', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Permission denied'),
    );
    render(<HandoffClient {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText(/clipboard access blocked/i)).toBeInTheDocument();
    });
  });

  it('shows already-handed-off copy when revisited', () => {
    render(<HandoffClient {...baseProps} alreadyHandedOff />);
    expect(screen.getByText(/already handed off/i)).toBeInTheDocument();
  });
});
