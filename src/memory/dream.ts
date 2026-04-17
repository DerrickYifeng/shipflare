import { z } from 'zod';
import { sideQuery } from '@/core/api-client';
import { MemoryStore } from './store';
import type { MemoryType, DistillAction } from './types';
import { MEMORY_CONFIG } from './types';

const DISTILL_MODEL = 'claude-haiku-4-5-20251001';

const distillOutputSchema = z.object({
  memories: z.array(z.object({
    name: z.string(),
    description: z.string(),
    type: z.enum(['user', 'feedback', 'project', 'reference']),
    content: z.string(),
    action: z.enum(['create', 'update', 'delete']),
  })),
});

const DISTILL_PROMPT = `You are performing a dream — a reflective pass over an AI marketing agent's memory. Synthesize recent observations into durable, well-organized memories so that future agent runs can orient quickly and make better decisions.

This agent helps market products on platforms like Reddit and X by discovering relevant threads, drafting replies, and posting them.

---

## Phase 1 — Orient

Review the existing memories provided below. Understand what the agent already knows about this product's marketing: which communities perform well, what content strategies work, audience pain points, and posting patterns. Identify gaps, outdated facts, and contradictions.

## Phase 2 — Gather signal

Analyze the new observations (raw logs from recent agent runs). Look for:
1. **Performance patterns** — which communities yield the most relevant threads, which content confidence scores are high/low
2. **Strategy insights** — what reply approaches get traction, what tone matches which communities
3. **Audience signals** — recurring pain points, common questions, sentiment patterns
4. **Failures and dead ends** — communities with no results, approaches that don't work, agent timeouts

Don't treat every observation as worth remembering. Look for patterns across multiple observations, not one-off data points.

## Phase 3 — Consolidate

For each insight worth preserving:
- **Merge over create** — update an existing memory rather than creating a near-duplicate
- **Convert relative dates to absolute** — "yesterday" → the actual date, so the memory remains interpretable later
- **Delete contradicted facts** — if new data disproves an old memory, fix it at the source
- **One insight per memory** — keep memories focused and specific

## Phase 4 — Prune

- If two memories say similar things, merge them into one
- Remove memories that are no longer accurate based on new observations
- Keep the total memory set lean — quality over quantity

---

## Memory Types

<types>
<type>
  <name>user</name>
  <description>Audience insights: target user personas, pain points, needs, and behaviors observed across communities. Helps the agent understand WHO it's writing for.</description>
  <when_to_save>When observations reveal recurring audience characteristics, common frustrations, or user segments that respond well to the product.</when_to_save>
  <examples>
  - "Users in r/SaaS frequently ask about analytics dashboards — they want simple, not enterprise-grade"
  - "Solo founders in r/SideProject respond better to 'I built this' framing than feature lists"
  - "X discussions about SaaS tools focus on pricing transparency and integrations"
  </examples>
</type>
<type>
  <name>feedback</name>
  <description>What works and what doesn't in this product's marketing. Strategy-level guidance learned from past runs — both successes and failures. Lead with the rule, then Why and How to apply.</description>
  <when_to_save>When content confidence scores reveal patterns, when certain approaches consistently perform well or poorly, when a community's tone requires specific adaptation.</when_to_save>
  <examples>
  - "High-confidence drafts (0.8+) correlate with threads where OP explicitly asks for recommendations. Why: direct intent match. How to apply: prioritize intent score >= 0.8 threads."
  - "r/programming replies need code examples or technical depth — marketing-speak gets downvoted. Why: technical audience. How to apply: include concrete technical details."
  </examples>
</type>
<type>
  <name>project</name>
  <description>Community-specific patterns, posting strategies, and campaign-level decisions. Operational knowledge about how to run this product's marketing.</description>
  <when_to_save>When discovery reveals community performance patterns, when posting timing matters, when specific query strategies yield better results.</when_to_save>
  <examples>
  - "r/startups yields 3x more relevant threads than r/Entrepreneur for this product. Best queries: workflow-struggle pattern."
  - "Discovery scans on weekday mornings find fresher threads (< 6h old) than weekend scans."
  - "X topic 'SaaS tools' surfaces high-intent threads but requires different tone than Reddit."
  </examples>
</type>
<type>
  <name>reference</name>
  <description>Useful communities, competitor threads, or external resources discovered during agent runs.</description>
  <when_to_save>When the agent discovers new relevant communities, competitor mentions, or useful resources.</when_to_save>
  <examples>
  - "r/NoCode is a high-relevance community discovered via cross-posts from r/SideProject"
  - "Competitor 'ToolX' is frequently mentioned in r/SaaS threads about this problem space"
  </examples>
</type>
</types>

## What NOT to save

- Raw thread data or URLs — these are in the database already
- One-off observations that don't form a pattern
- Exact thread counts from a single scan — these change every run
- Information already obvious from the product description

## Output

Return JSON with the actions to take:
\`\`\`json
{ "memories": [{ "name": "descriptive_slug", "description": "one-line summary for relevance matching", "type": "user|feedback|project|reference", "content": "full memory content", "action": "create|update|delete" }] }
\`\`\`

Names should be descriptive slugs (e.g., "community_saas_performance", "audience_pain_points_solo_founders").
For "delete" actions, only name is required.`;

/**
 * Auto-dream system for agent memory.
 * Ported from engine/memdir/memdir.ts buildAssistantDailyLogPrompt.
 *
 * Two phases:
 * A. Lightweight logging during agent runs (just DB inserts)
 * B. Distillation: LLM merges observations into structured memories
 */
export class AgentDream {
  constructor(private readonly store: MemoryStore) {}

  /**
   * Phase A: Log an insight from an agent run.
   * Just an INSERT, no LLM call — zero latency impact.
   */
  async logInsight(entry: string): Promise<void> {
    await this.store.appendLog(entry);
  }

  /**
   * Phase B: Check if distillation should be triggered.
   * Returns true if undistilled log count >= threshold.
   */
  async shouldDistill(): Promise<boolean> {
    const count = await this.store.getUndistilledLogCount();
    return count >= MEMORY_CONFIG.distillThreshold;
  }

  /**
   * Phase C: Run distillation.
   * Loads recent logs + existing memories, asks Haiku to merge,
   * applies create/update/delete actions to the memory store.
   */
  async distill(signal?: AbortSignal): Promise<DistillAction[]> {
    // 1. Load undistilled logs
    const epoch = new Date(0); // Get all undistilled
    const logs = await this.store.getRecentLogs(epoch);

    if (logs.length === 0) return [];

    // 2. Load full content of existing memories for context
    const headers = await this.store.listEntries();
    const existingMemories: string[] = [];
    for (const h of headers) {
      const entry = await this.store.loadEntry(h.name);
      if (entry) {
        existingMemories.push(`## ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.content}`);
      }
    }

    const existingContext = existingMemories.length > 0
      ? `# Existing Memories\n\n${existingMemories.join('\n\n---\n\n')}`
      : '# Existing Memories\n\nNone yet.';

    const observationsContext = `# New Observations\n\n${logs.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

    // 4. Side-query to Haiku
    const response = await sideQuery({
      model: DISTILL_MODEL,
      system: DISTILL_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${existingContext}\n\n${observationsContext}`,
        },
      ],
      maxTokens: 4096,
      signal,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return [];

    // 5. Parse and apply actions
    let actions: DistillAction[] = [];
    try {
      const jsonStr = extractJson(textBlock.text);
      const parsed = distillOutputSchema.parse(JSON.parse(jsonStr));
      actions = parsed.memories;
    } catch {
      // If parsing fails, don't apply anything
      return [];
    }

    for (const action of actions) {
      switch (action.action) {
        case 'create':
        case 'update':
          await this.store.saveEntry({
            name: action.name,
            description: action.description,
            type: action.type as MemoryType,
            content: action.content,
          });
          break;
        case 'delete':
          await this.store.removeEntry(action.name);
          break;
      }
    }

    // 6. Mark logs as distilled
    await this.store.markLogsDistilled(new Date());

    return actions;
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match?.[1]) return match[1].trim();
  const objMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objMatch?.[1]) return objMatch[1];
  return trimmed;
}
