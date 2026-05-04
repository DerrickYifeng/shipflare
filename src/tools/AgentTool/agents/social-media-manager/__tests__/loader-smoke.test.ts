// Plan 3 Task 2 — social-media-manager loader smoke. Verifies the new
// agent dir loads via the canonical `loadAgent(dirPath)` path with the
// real industry title in the description, the engine-aligned thin
// AGENT.md (no embedded pipeline prose, no Mode/Steps prescriptive
// scripts), and pattern-with-example references.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadAgent } from '@/tools/AgentTool/loader';

const AGENT_DIR = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents/social-media-manager',
);

describe('social-media-manager loader smoke', () => {
  it('loads with the real industry title in the description', async () => {
    const def = await loadAgent(AGENT_DIR);
    expect(def.name).toBe('social-media-manager');
    expect(def.description.toLowerCase()).toContain('social');
    expect(def.tools).toContain('process_replies_batch');
    expect(def.tools).toContain('process_posts_batch');
    expect(def.tools).toContain('find_threads_via_xai');
    expect(def.tools).toContain('find_threads');
    expect(def.role).toBe('member');
  });

  it('AGENT.md is thin (under 100 lines after frontmatter)', () => {
    const md = readFileSync(path.join(AGENT_DIR, 'AGENT.md'), 'utf8');
    const bodyLines = md.split('---').slice(2).join('---').split('\n').length;
    expect(bodyLines).toBeLessThan(100);
  });

  it('does NOT embed pipeline prose or prescriptive Mode-style scripts', () => {
    const md = readFileSync(path.join(AGENT_DIR, 'AGENT.md'), 'utf8');
    // Per the engine-aligned AGENT.md style: role + tools + patterns +
    // examples, not numbered scripts or "Mode: X" prose.
    expect(md).not.toMatch(/Per-item workflow/);
    expect(md).not.toMatch(/^Mode:/m);
    expect(md).not.toMatch(/Steps:\s*\n1\./m);
    expect(md).not.toMatch(/1\.\s+\*\*Judge\*\*/);
  });

  it('uses pattern-with-example style (engine-aligned)', () => {
    const md = readFileSync(
      path.join(AGENT_DIR, 'references/patterns-and-examples.md'),
      'utf8',
    );
    // Patterns introduced by "### Pattern:" header.
    expect(md).toMatch(/###\s+Pattern:/);
    // At least one concrete tool-call example shown as "You: ..."
    expect(md).toMatch(/You:\s+\S+/);
  });
});
