/**
 * Scene-layout metadata for the five agents in the isometric office.
 *
 * Each agent maps to a BullMQ worker per DATA_CONTRACT.md §2.1:
 *   Nova   → discovery
 *   Ember  → drafting   (content-batch)
 *   Sable  → review
 *   Arlo   → posting
 *   Kit    → scheduler  (no SSE event yet — falls back to "idle")
 *
 * `streamKey` is the lowercase agent name emitted by the /api/events SSE
 * feed in `agent-stream-provider.tsx`. We intentionally keep these IDs stable
 * (a1…a5) so future features can key handoff history / reordering on them.
 */

export type StreamKey = 'scout' | 'discovery' | 'content' | 'review' | 'posting' | 'scheduler';

export interface AgentEntry {
  id: 'a1' | 'a2' | 'a3' | 'a4' | 'a5';
  name: string;
  role: string;
  /** Grid coordinate of the agent's desk in tile units. */
  desk: { gx: number; gy: number };
  /** OKLCH accent hue — torso fill, monitor glow, avatar bubble. */
  hue: string;
  /** Key used to pull live state from the agent SSE stream. */
  streamKey: StreamKey;
  /** Short human description for the sidebar panel. */
  tagline: string;
  /** Preferred side for the floating name/status pill. */
  labelSide: 'left' | 'right';
}

export const AGENT_ROSTER: readonly AgentEntry[] = [
  {
    id: 'a1',
    name: 'Nova',
    role: 'Discovery',
    desk: { gx: 1, gy: 1 },
    hue: 'oklch(64% 0.18 250)',
    streamKey: 'discovery',
    tagline: 'Scans communities for threads worth replying to.',
    labelSide: 'right',
  },
  {
    id: 'a2',
    name: 'Ember',
    role: 'Drafting',
    desk: { gx: 3, gy: 1 },
    hue: 'oklch(72% 0.16 50)',
    streamKey: 'content',
    tagline: 'Drafts replies and scheduled posts in your voice.',
    labelSide: 'right',
  },
  {
    id: 'a3',
    name: 'Sable',
    role: 'Review',
    desk: { gx: 1, gy: 3 },
    hue: 'oklch(60% 0.14 320)',
    streamKey: 'review',
    tagline: 'Tone, safety, and FTC checks on every draft.',
    labelSide: 'left',
  },
  {
    id: 'a4',
    name: 'Arlo',
    role: 'Posting',
    desk: { gx: 3, gy: 3 },
    hue: 'oklch(66% 0.16 150)',
    streamKey: 'posting',
    tagline: 'Ships approved replies and posts on your schedule.',
    labelSide: 'right',
  },
  {
    id: 'a5',
    name: 'Kit',
    role: 'Scheduler',
    desk: { gx: 5, gy: 2 },
    hue: 'oklch(68% 0.14 200)',
    streamKey: 'scheduler',
    tagline: 'Plans the week and queues up the next scan window.',
    labelSide: 'left',
  },
] as const;

export type AgentId = AgentEntry['id'];

/**
 * Scene-facing status — mirrors the prototype's STATUS_META enum.
 * The live SSE stream speaks in `active|complete|idle|error`; we lift
 * those coarse states into per-role flavor (`searching` for Nova, etc.).
 */
export type SceneStatus =
  | 'idle'
  | 'searching'
  | 'drafting'
  | 'reviewing'
  | 'posting'
  | 'blocked'
  | 'walking';

export interface StatusMeta {
  label: string;
  tone: 'dim' | 'signal' | 'flare' | 'success' | 'danger';
  dot: 'active' | 'idle' | 'danger';
}

export const STATUS_META: Record<SceneStatus, StatusMeta> = {
  idle: { label: 'IDLE', tone: 'dim', dot: 'idle' },
  searching: { label: 'SEARCHING', tone: 'signal', dot: 'active' },
  drafting: { label: 'DRAFTING', tone: 'flare', dot: 'active' },
  reviewing: { label: 'REVIEWING', tone: 'signal', dot: 'active' },
  posting: { label: 'POSTING', tone: 'success', dot: 'active' },
  blocked: { label: 'BLOCKED', tone: 'danger', dot: 'danger' },
  walking: { label: 'HANDOFF', tone: 'signal', dot: 'active' },
};

const ACTIVE_FLAVOR: Record<AgentId, SceneStatus> = {
  a1: 'searching',
  a2: 'drafting',
  a3: 'reviewing',
  a4: 'posting',
  a5: 'searching',
};

/**
 * Map the SSE `AgentState.status` back onto our richer scene status.
 * `error` → `blocked` (what we render), anything else active → role flavor.
 */
export function sceneStatusFor(
  id: AgentId,
  streamStatus: 'active' | 'complete' | 'idle' | 'error' | undefined,
): SceneStatus {
  if (streamStatus === 'error') return 'blocked';
  if (streamStatus === 'active') return ACTIVE_FLAVOR[id];
  return 'idle';
}

/** Tile size in isometric units — see PIXEL_ART.md §Coordinate system. */
export const TILE_W = 56;
export const TILE_H = 28;

/** Grid → screen projection helper. */
export function isoToXY(gx: number, gy: number): { x: number; y: number } {
  return {
    x: (gx - gy) * TILE_W,
    y: (gx + gy) * TILE_H,
  };
}
