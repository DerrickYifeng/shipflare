// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';

import { SendMessageForm } from '../send-message-form';
import { ToastProvider } from '@/components/ui/toast';

function renderForm(props: Partial<Parameters<typeof SendMessageForm>[0]> = {}) {
  return render(
    <ToastProvider>
      <SendMessageForm teamId="team-1" recipientName="Sam" {...props} />
    </ToastProvider>,
  );
}

describe('<SendMessageForm>', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('disables submit while the input is empty', () => {
    renderForm();
    expect(
      (screen.getByTestId('send-message-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('posts the trimmed message to /api/team/message and clears on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageId: 'm1' }),
    });

    const onSent = vi.fn();
    renderForm({ memberId: 'member-42', onSent });

    const textarea = screen.getByTestId('send-message-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '  Re-plan this week  ' } });
    fireEvent.click(screen.getByTestId('send-message-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/team/message');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      teamId: 'team-1',
      memberId: 'member-42',
      message: 'Re-plan this week',
    });
    await waitFor(() => {
      expect(textarea.value).toBe('');
    });
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('uses a role-aware placeholder for known agent_types', () => {
    renderForm({ agentType: 'growth-strategist' });
    const textarea = screen.getByTestId('send-message-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('growth strategist');
  });

  it('disables submit once the draft exceeds the 500-char cap', () => {
    renderForm();
    const textarea = screen.getByTestId('send-message-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'x'.repeat(501) } });
    expect(
      (screen.getByTestId('send-message-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('surfaces an error when the POST fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_body' }),
    });

    renderForm();
    const textarea = screen.getByTestId('send-message-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send-message-submit'));

    // Both the inline error and the toast say the same thing; scope the
    // assertion to the form so the toast (which lives in a portal-ish
    // sibling tree) doesn't cause an ambiguous match.
    const form = screen.getByTestId('send-message-form');
    await waitFor(() => {
      expect(form.textContent).toContain('invalid_body');
    });
    // Keep the user's draft so they can retry without retyping.
    expect(textarea.value).toBe('hello');
  });
});
