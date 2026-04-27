import { describe, it, expect, vi, beforeEach } from 'vitest';

const { publishUserEventMock, loggerWarnMock } = vi.hoisted(() => ({
  publishUserEventMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  publishUserEvent: (...args: unknown[]) => publishUserEventMock(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
  }),
}));

import {
  publishToolProgress,
  __resetDroppedCounter,
  __getDroppedCount,
} from '../publish-tool-progress';

describe('publishToolProgress', () => {
  beforeEach(() => {
    publishUserEventMock.mockReset();
    loggerWarnMock.mockReset();
    __resetDroppedCounter();
  });

  it('publishes a tool_progress event into the agents channel', async () => {
    publishUserEventMock.mockResolvedValueOnce(undefined);

    await publishToolProgress({
      userId: 'u1',
      toolName: 'calibrate_search_strategy',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58 },
    });

    expect(publishUserEventMock).toHaveBeenCalledTimes(1);
    const [userId, channel, payload] = publishUserEventMock.mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(channel).toBe('agents');
    expect(payload).toMatchObject({
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58 },
    });
    expect(typeof payload.callId).toBe('string');
    expect(payload.callId.length).toBeGreaterThan(0);
    expect(typeof payload.ts).toBe('number');
  });

  it('does not throw and increments dropped counter when publish fails', async () => {
    publishUserEventMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      publishToolProgress({
        userId: 'u1',
        toolName: 'run_discovery_scan',
        message: 'Searching X with 12 queries',
      }),
    ).resolves.toBeUndefined();

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const warnCallArgs = loggerWarnMock.mock.calls[0]!;
    expect(warnCallArgs[0]).toContain('dropped tool_progress event');
    expect(warnCallArgs[1]).toMatchObject({
      toolName: 'run_discovery_scan',
      error: 'redis down',
    });
    expect(__getDroppedCount()).toBe(1);
  });
});
