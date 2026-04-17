import { describe, it, expectTypeOf } from 'vitest';
import type {
  PipelineEvent,
  Pipeline,
  ItemState,
  PipelineStage,
} from '../pipeline-events';

describe('PipelineEvent type', () => {
  it('accepts all three pipelines', () => {
    expectTypeOf<Pipeline>().toEqualTypeOf<'plan' | 'reply' | 'discovery'>();
  });

  it('accepts all item states', () => {
    const states: ItemState[] = [
      'queued',
      'drafting',
      'ready',
      'failed',
      'searching',
      'searched',
    ];
    expectTypeOf(states).toEqualTypeOf<ItemState[]>();
  });

  it('PipelineEvent is shape-safe', () => {
    const e: PipelineEvent<{ topic: string }> = {
      pipeline: 'plan',
      itemId: 'abc',
      state: 'ready',
      data: { topic: 'x' },
      seq: 1,
    };
    expectTypeOf(e.pipeline).toEqualTypeOf<Pipeline>();
  });

  it('PipelineStage includes new stages', () => {
    const stages: PipelineStage[] = [
      'plan_shell_ready',
      'source_searched',
      'thread_ready',
    ];
    expectTypeOf(stages).toEqualTypeOf<PipelineStage[]>();
  });
});
