// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RedditHandleInput } from '../reddit-handle-input';

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('RedditHandleInput', () => {
  it('strips u/ prefix from typed input', async () => {
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    const input = screen.getByLabelText(
      /your reddit username/i,
    ) as HTMLInputElement;
    await userEvent.type(input, 'u/foo');
    expect(input.value).toBe('foo');
  });

  it('shows verified state after Verify succeeds', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: true, karma: 1234 }),
    });
    render(<RedditHandleInput onSubmit={vi.fn()} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => {
      expect(screen.getByText(/1,234 karma/i)).toBeInTheDocument();
    });
  });

  it('shows soft-block dialog on Connect when handle not found', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: false }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/we couldn't find u\/foo/i));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Continue anyway calls onSubmit with verified=false', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: false }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/we couldn't find/i));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
    expect(onSubmit).toHaveBeenCalledWith('foo', false);
  });

  it('verified state submits with verified=true', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: true, karma: 100 }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/✓ verified/i));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onSubmit).toHaveBeenCalledWith('foo', true);
  });

  it('renders an alert when onSubmit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Save failed (500)'));
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /save failed \(500\)/i,
      );
    });
  });

  it('falls back to a generic message when onSubmit rejects with non-Error', async () => {
    const onSubmit = vi.fn().mockRejectedValue('boom');
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText(/your reddit username/i),
      'foo',
    );
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not save handle/i,
      );
    });
  });

  it('strips a leading /u/ prefix as well', async () => {
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    const input = screen.getByLabelText(
      /your reddit username/i,
    ) as HTMLInputElement;
    await userEvent.type(input, '/u/foo');
    expect(input.value).toBe('foo');
  });
});
