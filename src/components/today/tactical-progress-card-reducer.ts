// Pure tool_progress reducer — extracted so it can be unit-tested without
// rendering React. `tactical-progress-card.tsx` re-exports all public
// symbols from here, so test imports against `../tactical-progress-card`
// continue to work unchanged.

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface ToolProgressEventInput {
  type: 'tool_progress';
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

export interface CalibrationRow {
  platform: string;
  callId: string;
  round: number | null;
  maxTurns: number | null;
  precision: number | null;
  sampleSize: number | null;
  message: string;
  ts: number;
}

export interface DiscoveryRow {
  platform: string;
  callId: string;
  mode: 'inline' | 'calibrated' | null;
  queryCount: number | null;
  message: string;
  ts: number;
}

export interface TickerRow {
  toolName: string;
  callId: string;
  message: string;
  ts: number;
}

export interface ToolProgressViewState {
  calibration: Record<string, CalibrationRow>;
  discovery: Record<string, DiscoveryRow>;
  ticker: TickerRow | null;
}

export const INITIAL_TOOL_PROGRESS: ToolProgressViewState = {
  calibration: {},
  discovery: {},
  ticker: null,
};

/* ─── Helpers ────────────────────────────────────────────────────────── */

function readNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/* ─── Reducer ────────────────────────────────────────────────────────── */

export function reduceToolProgress(
  state: ToolProgressViewState,
  event: ToolProgressEventInput,
): ToolProgressViewState {
  if (event.type !== 'tool_progress') return state;

  if (event.toolName === 'calibrate_search_strategy') {
    const platform = readString(event.metadata, 'platform') ?? 'default';
    const prev = state.calibration[platform];
    if (prev && prev.callId === event.callId && prev.ts >= event.ts) {
      return state;
    }
    return {
      ...state,
      calibration: {
        ...state.calibration,
        [platform]: {
          platform,
          callId: event.callId,
          round: readNumber(event.metadata, 'round'),
          maxTurns: readNumber(event.metadata, 'maxTurns'),
          precision: readNumber(event.metadata, 'precision'),
          sampleSize: readNumber(event.metadata, 'sampleSize'),
          message: event.message,
          ts: event.ts,
        },
      },
    };
  }

  if (event.toolName === 'run_discovery_scan') {
    const platform = readString(event.metadata, 'platform') ?? 'default';
    const prev = state.discovery[platform];
    if (prev && prev.callId === event.callId && prev.ts >= event.ts) {
      return state;
    }
    const modeRaw = readString(event.metadata, 'mode');
    const mode: DiscoveryRow['mode'] =
      modeRaw === 'inline' || modeRaw === 'calibrated' ? modeRaw : null;
    return {
      ...state,
      discovery: {
        ...state.discovery,
        [platform]: {
          platform,
          callId: event.callId,
          mode,
          queryCount: readNumber(event.metadata, 'queryCount'),
          message: event.message,
          ts: event.ts,
        },
      },
    };
  }

  if (state.ticker && state.ticker.ts >= event.ts) {
    return state;
  }
  return {
    ...state,
    ticker: {
      toolName: event.toolName,
      callId: event.callId,
      message: event.message,
      ts: event.ts,
    },
  };
}
