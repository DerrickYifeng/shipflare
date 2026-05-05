import { describe, it, expect, vi } from 'vitest';
import { generatingStrategyOutputSchema } from '@/skills/generating-strategy/schema';

const runForkSkillMock = vi.hoisted(() => vi.fn());
vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: runForkSkillMock,
}));

import { generateStrategicPathTool } from '../GenerateStrategicPathTool';

const fakeCtx = () =>
  ({
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  }) as unknown as Parameters<typeof generateStrategicPathTool.execute>[1];

describe('generate_strategic_path tool', () => {
  it('invokes generating-strategy via runForkSkill and returns its structured result', async () => {
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        status: 'completed',
        pathId: '11111111-2222-3333-4444-555555555555',
        summary: 'Launched yesterday — pivoting to compound growth.',
        notes: 'Move pillars to retention math + community voices.',
      },
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    });

    const out = await generateStrategicPathTool.execute(
      { args: '{"product":{"name":"p","description":"d"},"state":"launched","currentPhase":"compound","channels":["x"],"today":"2026-05-02","weekStart":"2026-04-27"}' },
      fakeCtx(),
    );

    expect(runForkSkillMock).toHaveBeenCalledWith(
      'generating-strategy',
      expect.stringContaining('"product"'),
      generatingStrategyOutputSchema,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(out).toEqual({
      status: 'completed',
      pathId: '11111111-2222-3333-4444-555555555555',
      summary: 'Launched yesterday — pivoting to compound growth.',
      notes: 'Move pillars to retention math + community voices.',
    });
  });

  it('rejects empty args at the schema boundary', () => {
    expect(() =>
      generateStrategicPathTool.inputSchema.parse({ args: '' }),
    ).toThrow();
  });
});
