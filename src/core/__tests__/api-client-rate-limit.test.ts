/**
 * Unit tests for the Phase B5 rate-limit primitives in
 * `src/core/api-client.ts`:
 *
 *   1. `LlmRateLimitedError` class — payload shape across all three
 *      deny scopes (tenant | global | config).
 *   2. `createMessage` token-bucket integration — verifies the
 *      acquire happens when (and only when) `tenantId` is supplied,
 *      and that deny throws the typed error while fail-open lets the
 *      call proceed.
 *
 * The bucket helper (`tryAcquireLlmTokens`) is mocked so we exercise
 * the wiring without standing up a real Redis. The Anthropic SDK is
 * also mocked so a happy-path acquire doesn't make a network call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmRateLimitedError } from '../api-client';

describe('LlmRateLimitedError', () => {
  it('carries scope and retryMs on tenant deny', () => {
    const err = new LlmRateLimitedError('tenant', 1500);
    expect(err.scope).toBe('tenant');
    expect(err.retryMs).toBe(1500);
    expect(err.name).toBe('LlmRateLimitedError');
    expect(err.message).toContain('tenant');
    expect(err.message).toContain('1500');
  });

  it('supports global scope', () => {
    const err = new LlmRateLimitedError('global', 250);
    expect(err.scope).toBe('global');
    expect(err.retryMs).toBe(250);
    expect(err.message).toContain('global');
  });

  it('supports config scope (programming bug)', () => {
    const err = new LlmRateLimitedError('config', 0);
    expect(err.scope).toBe('config');
    expect(err.retryMs).toBe(0);
    expect(err.message).toContain('config');
  });

  it('is an instance of Error (for instanceof catch)', () => {
    const err = new LlmRateLimitedError('tenant', 100);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmRateLimitedError);
  });
});

// ---------------------------------------------------------------------------
// createMessage integration with the token bucket
// ---------------------------------------------------------------------------

const tryAcquireLlmTokensMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/redis-scripts/llm-token-bucket', () => ({
  tryAcquireLlmTokens: tryAcquireLlmTokensMock,
}));

vi.mock('@/lib/redis', () => ({
  getKeyValueClient: () => ({}),
}));

// Mock the Anthropic SDK so happy-path tests don't make a network call.
// Each test that reaches the SDK provides a `finalMessage` via the
// `streamMock` hoisted ref.
const streamMock = vi.hoisted(() => ({
  finalMessage: vi.fn(async () => ({
    content: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })),
  on: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAPIError extends Error {
    status = 0;
    headers: Record<string, string> = {};
  }
  // The retry helper uses `instanceof Anthropic.APIError` for
  // classification — exposing a class lets tests trigger that branch
  // if needed. Use a real class with a constructor so `new Anthropic()`
  // in api-client.ts works.
  class FakeAnthropic {
    messages = { stream: () => streamMock };
    static APIError = FakeAPIError;
  }
  return { default: FakeAnthropic };
});

describe('createMessage — token-bucket integration', () => {
  beforeEach(() => {
    tryAcquireLlmTokensMock.mockReset();
    streamMock.finalMessage.mockClear();
  });

  afterEach(() => {
    delete process.env.LLM_TENANT_RPM;
    delete process.env.LLM_GLOBAL_RPM;
  });

  it('does NOT acquire when tenantId is absent (pre-B5 behavior)', async () => {
    const { createMessage } = await import('../api-client');
    await createMessage({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(tryAcquireLlmTokensMock).not.toHaveBeenCalled();
  });

  it('acquires from the bucket when tenantId is supplied', async () => {
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: true,
      tenantRemaining: 59,
      globalRemaining: 899,
    });

    const { createMessage } = await import('../api-client');
    await createMessage({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'user-abc',
    });

    expect(tryAcquireLlmTokensMock).toHaveBeenCalledOnce();
    const call = tryAcquireLlmTokensMock.mock.calls[0]!;
    const opts = call[1] as {
      tenantKey: string;
      tenantCap: number;
      globalKey: string;
      globalCap: number;
    };
    expect(opts.tenantKey).toBe('llm:tenant:user-abc');
    expect(opts.globalKey).toBe('llm:global:anthropic');
    // Defaults — env vars unset.
    expect(opts.tenantCap).toBe(60);
    expect(opts.globalCap).toBe(900);
    expect(streamMock.finalMessage).toHaveBeenCalledOnce();
  });

  it('honors LLM_TENANT_RPM / LLM_GLOBAL_RPM env vars', async () => {
    process.env.LLM_TENANT_RPM = '120';
    process.env.LLM_GLOBAL_RPM = '1800';
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: true,
      tenantRemaining: 119,
      globalRemaining: 1799,
    });

    const { createMessage } = await import('../api-client');
    await createMessage({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'user-xyz',
    });

    const call = tryAcquireLlmTokensMock.mock.calls[0]!;
    const opts = call[1] as { tenantCap: number; globalCap: number };
    expect(opts.tenantCap).toBe(120);
    expect(opts.globalCap).toBe(1800);
  });

  it('falls back to defaults on malformed env vars', async () => {
    process.env.LLM_TENANT_RPM = 'banana';
    process.env.LLM_GLOBAL_RPM = '-5';
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: true,
      tenantRemaining: 59,
      globalRemaining: 899,
    });

    const { createMessage } = await import('../api-client');
    await createMessage({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'user-1',
    });

    const call = tryAcquireLlmTokensMock.mock.calls[0]!;
    const opts = call[1] as { tenantCap: number; globalCap: number };
    expect(opts.tenantCap).toBe(60);
    expect(opts.globalCap).toBe(900);
  });

  it('throws LlmRateLimitedError(tenant) on tenant deny', async () => {
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: false,
      scope: 'tenant',
      retryMs: 1200,
    });

    const { createMessage } = await import('../api-client');
    await expect(
      createMessage({
        model: 'claude-haiku-4-5-20251001',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tenantId: 'user-1',
      }),
    ).rejects.toMatchObject({
      name: 'LlmRateLimitedError',
      scope: 'tenant',
      retryMs: 1200,
    });
    expect(streamMock.finalMessage).not.toHaveBeenCalled();
  });

  it('throws LlmRateLimitedError(global) on global deny', async () => {
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: false,
      scope: 'global',
      retryMs: 800,
    });

    const { createMessage } = await import('../api-client');
    await expect(
      createMessage({
        model: 'claude-haiku-4-5-20251001',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tenantId: 'user-1',
      }),
    ).rejects.toMatchObject({
      name: 'LlmRateLimitedError',
      scope: 'global',
      retryMs: 800,
    });
  });

  it('throws LlmRateLimitedError(config) on config deny', async () => {
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: false,
      scope: 'config',
      retryMs: 0,
    });

    const { createMessage } = await import('../api-client');
    await expect(
      createMessage({
        model: 'claude-haiku-4-5-20251001',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tenantId: 'user-1',
      }),
    ).rejects.toMatchObject({
      name: 'LlmRateLimitedError',
      scope: 'config',
    });
  });

  it('proceeds with the API call when bucket fails open', async () => {
    tryAcquireLlmTokensMock.mockResolvedValueOnce({
      allowed: true,
      failedOpen: true,
    });

    const { createMessage } = await import('../api-client');
    await createMessage({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'user-1',
    });

    expect(streamMock.finalMessage).toHaveBeenCalledOnce();
  });
});
