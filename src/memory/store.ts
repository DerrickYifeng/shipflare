import { db } from '@/lib/db';
import { agentMemories, agentMemoryLogs } from '@/lib/db/schema';
import { eq, and, gt, sql, lt } from 'drizzle-orm';
import type { MemoryEntry, MemoryHeader, MemoryType } from './types';
import { MEMORY_CONFIG } from './types';

/**
 * Supabase-backed memory store.
 * Replaces engine's filesystem-based MEMORY.md + topic .md files.
 *
 * Same interface as engine's memdir but backed by PostgreSQL.
 */
export class MemoryStore {
  constructor(private readonly productId: string) {}

  /**
   * Get all productIds that have undistilled log entries.
   * Used by the nightly dream cron to enumerate products for distillation.
   */
  static async getProductsWithUndistilledLogs(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ productId: agentMemoryLogs.productId })
      .from(agentMemoryLogs)
      .where(eq(agentMemoryLogs.distilled, false));

    return rows.map((r) => r.productId);
  }

  // ---------------------------------------------------------------------------
  // Index — replaces MEMORY.md
  // ---------------------------------------------------------------------------

  /**
   * Build the memory index string (equivalent to engine's MEMORY.md).
   * Format: "- [name](name) — description" per line.
   * Truncated to maxIndexLines / maxIndexBytes.
   */
  async loadIndex(): Promise<string> {
    const entries = await db
      .select({
        name: agentMemories.name,
        description: agentMemories.description,
      })
      .from(agentMemories)
      .where(eq(agentMemories.productId, this.productId))
      .orderBy(agentMemories.updatedAt);

    const lines: string[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
      if (lines.length >= MEMORY_CONFIG.maxIndexLines) break;

      const line = `- [${entry.name}](${entry.name}) — ${entry.description}`;
      const lineBytes = new TextEncoder().encode(line + '\n').length;

      if (totalBytes + lineBytes > MEMORY_CONFIG.maxIndexBytes) break;

      lines.push(line);
      totalBytes += lineBytes;
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------------

  /** List all memory headers (no content). */
  async listEntries(): Promise<MemoryHeader[]> {
    const rows = await db
      .select({
        name: agentMemories.name,
        description: agentMemories.description,
        type: agentMemories.type,
        updatedAt: agentMemories.updatedAt,
      })
      .from(agentMemories)
      .where(eq(agentMemories.productId, this.productId))
      .orderBy(agentMemories.updatedAt);

    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      type: r.type as MemoryType,
      updatedAt: r.updatedAt,
    }));
  }

  /** Load a full memory entry by name. */
  async loadEntry(name: string): Promise<MemoryEntry | null> {
    const [row] = await db
      .select()
      .from(agentMemories)
      .where(
        and(eq(agentMemories.productId, this.productId), eq(agentMemories.name, name)),
      )
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      productId: row.productId,
      name: row.name,
      description: row.description,
      type: row.type as MemoryType,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Save (upsert) a memory entry by name. */
  async saveEntry(entry: {
    name: string;
    description: string;
    type: MemoryType;
    content: string;
  }): Promise<void> {
    await db
      .insert(agentMemories)
      .values({
        productId: this.productId,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
      })
      .onConflictDoUpdate({
        target: [agentMemories.productId, agentMemories.name],
        set: {
          description: entry.description,
          type: entry.type,
          content: entry.content,
          updatedAt: new Date(),
        },
      });
  }

  /** Remove a memory entry by name. */
  async removeEntry(name: string): Promise<void> {
    await db
      .delete(agentMemories)
      .where(
        and(eq(agentMemories.productId, this.productId), eq(agentMemories.name, name)),
      );
  }

  // ---------------------------------------------------------------------------
  // Logs (for dream system)
  // ---------------------------------------------------------------------------

  /** Append a log entry (just a DB insert, zero latency impact). */
  async appendLog(entry: string): Promise<void> {
    await db.insert(agentMemoryLogs).values({
      productId: this.productId,
      entry,
    });
  }

  /** Get recent logs since a given date. */
  async getRecentLogs(since: Date): Promise<string[]> {
    const rows = await db
      .select({ entry: agentMemoryLogs.entry })
      .from(agentMemoryLogs)
      .where(
        and(
          eq(agentMemoryLogs.productId, this.productId),
          gt(agentMemoryLogs.loggedAt, since),
        ),
      )
      .orderBy(agentMemoryLogs.loggedAt);

    return rows.map((r) => r.entry);
  }

  /** Count undistilled logs (for threshold trigger). */
  async getUndistilledLogCount(): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentMemoryLogs)
      .where(
        and(
          eq(agentMemoryLogs.productId, this.productId),
          eq(agentMemoryLogs.distilled, false),
        ),
      );

    return result?.count ?? 0;
  }

  /** Mark logs as distilled (after distillation). */
  async markLogsDistilled(before: Date): Promise<void> {
    await db
      .update(agentMemoryLogs)
      .set({ distilled: true })
      .where(
        and(
          eq(agentMemoryLogs.productId, this.productId),
          eq(agentMemoryLogs.distilled, false),
          lt(agentMemoryLogs.loggedAt, before),
        ),
      );
  }
}
