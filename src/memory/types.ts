/**
 * Memory type taxonomy.
 * Ported from engine/memdir/memoryTypes.ts.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * Full memory entry with content.
 */
export interface MemoryEntry {
  id: string;
  productId: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Memory header (no content) for listing/manifest.
 */
export interface MemoryHeader {
  name: string;
  description: string;
  type: MemoryType;
  updatedAt: Date;
}

/**
 * Memory log entry (for dream system).
 */
export interface MemoryLogEntry {
  id: string;
  productId: string;
  entry: string;
  loggedAt: Date;
  distilled: boolean;
}

/**
 * Memory config constants.
 * From engine/memdir/memdir.ts defaults.
 */
export const MEMORY_CONFIG = {
  /** Maximum lines in the memory index (MEMORY.md equivalent). */
  maxIndexLines: 200,
  /** Maximum bytes for the index string. */
  maxIndexBytes: 25_000,
  /** Minimum undistilled logs before triggering distillation. */
  distillThreshold: 20,
} as const;

/**
 * Distillation action from the LLM.
 */
export interface DistillAction {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  action: 'create' | 'update' | 'delete';
}
