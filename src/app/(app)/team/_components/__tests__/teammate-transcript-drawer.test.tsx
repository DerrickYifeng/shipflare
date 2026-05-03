// @vitest-environment happy-dom
//
// UI-B Task 9 — TeammateTranscriptDrawer behavior tests.
//
// `fetch` is mocked so we can drive the loading → ready → error states
// deterministically without hitting the route. Verifies:
//   - drawer renders nothing when agentId is null
//   - shows loading state while fetch is in flight
//   - renders messages with role-based dataset markers on success
//   - shows error state on non-2xx responses
//   - close button + backdrop fire onClose
//   - re-pointing at a different agent re-fetches and resets state

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

import { TeammateTranscriptDrawer } from '../teammate-transcript-drawer';

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

let fetchImpl: (url: string) => Promise<MockFetchResponse> = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ messages: [] }),
});

beforeEach(() => {
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [] }),
  });
  vi.stubGlobal('fetch', vi.fn((url: string) => fetchImpl(url)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('<TeammateTranscriptDrawer>', () => {
  it('renders nothing when agentId is null', () => {
    render(<TeammateTranscriptDrawer agentId={null} onClose={() => {}} />);
    expect(screen.queryByTestId('teammate-transcript-drawer')).toBeNull();
  });

  it('renders the drawer skeleton with loading state when agentId is set', async () => {
    // Hold the response open so the loading state stays visible.
    let resolveResponse: (value: MockFetchResponse) => void = () => {};
    fetchImpl = () =>
      new Promise<MockFetchResponse>((resolve) => {
        resolveResponse = resolve;
      });
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={() => {}} />);
    expect(screen.getByTestId('teammate-transcript-drawer')).toBeTruthy();
    expect(screen.getByTestId('teammate-transcript-loading')).toBeTruthy();
    // Resolve so the test doesn't leak a pending promise.
    resolveResponse({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });
    await act(async () => {
      await flushPromises();
    });
  });

  it('renders messages with role data attributes on a successful load', async () => {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          { role: 'user', content: 'kick off a draft' },
          { role: 'assistant', content: 'three drafts ready' },
        ],
      }),
    });
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={() => {}} />);
    await act(async () => {
      await flushPromises();
    });
    const bubbles = screen.getAllByTestId('teammate-transcript-message');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].getAttribute('data-role')).toBe('user');
    expect(bubbles[0].textContent).toContain('kick off a draft');
    expect(bubbles[1].getAttribute('data-role')).toBe('assistant');
    expect(bubbles[1].textContent).toContain('three drafts ready');
  });

  it('renders the empty state when the agent has no transcript', async () => {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={() => {}} />);
    await act(async () => {
      await flushPromises();
    });
    expect(screen.getByTestId('teammate-transcript-empty')).toBeTruthy();
  });

  it('surfaces an error state on non-2xx responses', async () => {
    fetchImpl = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={() => {}} />);
    await act(async () => {
      await flushPromises();
    });
    const err = screen.getByTestId('teammate-transcript-error');
    expect(err.textContent).toContain('500');
  });

  it('fires onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={onClose} />);
    await act(async () => {
      await flushPromises();
    });
    fireEvent.click(screen.getByTestId('teammate-transcript-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(<TeammateTranscriptDrawer agentId="agent-1" onClose={onClose} />);
    await act(async () => {
      await flushPromises();
    });
    fireEvent.click(screen.getByTestId('teammate-transcript-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses the title prop when supplied', async () => {
    render(
      <TeammateTranscriptDrawer
        agentId="agent-1"
        title="Author transcript"
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await flushPromises();
    });
    const dialog = screen.getByTestId('teammate-transcript-drawer');
    expect(dialog.getAttribute('aria-label')).toBe('Author transcript');
    expect(dialog.textContent).toContain('Author transcript');
  });

  it('refetches when agentId changes', async () => {
    const calls: string[] = [];
    fetchImpl = async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
      };
    };
    const { rerender } = render(
      <TeammateTranscriptDrawer agentId="agent-1" onClose={() => {}} />,
    );
    await act(async () => {
      await flushPromises();
    });
    rerender(
      <TeammateTranscriptDrawer agentId="agent-2" onClose={() => {}} />,
    );
    await act(async () => {
      await flushPromises();
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/agent-1/');
    expect(calls[1]).toContain('/agent-2/');
  });
});
