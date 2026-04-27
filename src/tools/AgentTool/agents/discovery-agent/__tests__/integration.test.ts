// Integration test scaffold for discovery-agent.
//
// Deeper LLM-driven integration testing (mocking the Anthropic createMessage
// boundary, driving the agent through scripted turn responses, asserting
// tool dispatch order + StructuredOutput shape) is deferred as a follow-up
// — the pattern would mirror src/workers/processors/__tests__/team-run-*
// integration tests, which mock createMessage and let the runAgent harness
// execute against synthetic LLM outputs.
//
// For v1 the agent's correctness is covered transitively by:
//   - xai_find_customers.test.ts: tool input/output, model selection,
//     emit-progress wiring, schema-validation throw path
//   - persist_queue_threads.test.ts: engagement-weighted sort, dedup,
//     repost merge
//   - discovery-agent loader-smoke: AGENT.md frontmatter shape +
//     output-schema registration
//   - team-kickoff.test.ts: goal text dispatches Task(discovery-agent)
//   - manual smoke per the plan's Task 19 checklist
//
// This file exists so future contributors have a clear hook to add a
// real integration test without scaffolding from scratch.

import { describe, it, expect } from 'vitest';
import { discoveryAgentOutputSchema } from '../schema';

describe('discovery-agent integration scaffold', () => {
  it('output schema parses a valid agent payload', () => {
    const valid = {
      queued: 3,
      scanned: 14,
      scoutNotes: '14 candidates judged; 3 strong matches; 11 filtered.',
      costUsd: 0.12,
      topQueued: [
        {
          externalId: 'tweet-1',
          url: 'https://x.com/alice/status/1',
          authorUsername: 'alice',
          body: 'looking for marketing automation',
          likesCount: 12,
          repostsCount: 3,
          confidence: 0.85,
        },
      ],
    };
    const parsed = discoveryAgentOutputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('output schema rejects malformed payload (missing topQueued)', () => {
    const invalid = {
      queued: 3,
      scanned: 14,
      scoutNotes: 'x',
      costUsd: 0.12,
      // topQueued missing
    };
    const parsed = discoveryAgentOutputSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});
