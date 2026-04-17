import pc from 'picocolors';

/**
 * Structured logger.
 *
 * Two output modes, selected by `LOG_FORMAT` (falling back to NODE_ENV):
 *  - `pretty` (default in development): picocolors-tinted single-line output
 *    that is easy on human eyes during `pnpm dev`.
 *  - `json` (default in production): one JSON object per line, pino-shape
 *    compatible. The shape — `{ ts, level, module, msg, ...ctx }` — can be
 *    ingested by Railway / Axiom / Datadog / any log aggregator that expects
 *    structured JSON, without dragging pino (+transport deps) into the bundle.
 *
 * Every logger may have a bound context (via `child({...})`) so fields like
 * `traceId`, `jobId`, `userId`, `runId` flow through every line without the
 * caller re-passing them. This is how we thread a job's `traceId` from
 * enqueue → processor → API client.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getThreshold(): number {
  return LEVELS[process.env.LOG_LEVEL as LogLevel] ?? LEVELS.info;
}

function getFormat(): 'json' | 'pretty' {
  const explicit = process.env.LOG_FORMAT;
  if (explicit === 'json' || explicit === 'pretty') return explicit;
  return process.env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

// Resolve once at module load — the format is driven by environment which
// does not change inside a process.
const FORMAT: 'json' | 'pretty' = getFormat();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** Return a new logger whose every line includes these fields. */
  child(ctx: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// Pretty writer (dev)
// ---------------------------------------------------------------------------

function ts(): string {
  return pc.dim(new Date().toISOString().slice(11, 23));
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: pc.dim('DBG'),
  info: pc.cyan('INF'),
  warn: pc.yellow('WRN'),
  error: pc.red('ERR'),
};

function formatCtx(ctx: LogContext): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = ctx[k];
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${pc.dim(k)}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function writePretty(
  level: LogLevel,
  module: string,
  ctx: LogContext,
  msg: string,
  args: unknown[],
): void {
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  const tag = pc.bold(`[${module}]`);
  out(`${ts()} ${LEVEL_LABELS[level]} ${tag}${formatCtx(ctx)} ${msg}`, ...args);
}

// ---------------------------------------------------------------------------
// JSON writer (prod — pino-shape)
// ---------------------------------------------------------------------------

/**
 * Serialise an Error to a plain object. Other non-primitive args are returned
 * as-is; pino serializes them the same way via safe-stable-stringify, we rely
 * on JSON.stringify + a replacer that skips BigInt / circular refs.
 */
function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      type: arg.name,
      message: arg.message,
      stack: arg.stack,
    };
  }
  return arg;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function writeJson(
  level: LogLevel,
  module: string,
  ctx: LogContext,
  msg: string,
  args: unknown[],
): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module,
    ...ctx,
    msg,
  };
  if (args.length > 0) {
    // Preserve any extra positional args under `args` — processors / API
    // routes historically do `log.error('failed', err)` so the error payload
    // must be visible in the JSON line.
    record.args = args.map(serializeArg);
  }
  const line = JSON.stringify(record, jsonReplacer);
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeLogger(module: string, boundCtx: LogContext): Logger {
  const write = (level: LogLevel, msg: string, args: unknown[]) => {
    if (LEVELS[level] < getThreshold()) return;
    if (FORMAT === 'json') {
      writeJson(level, module, boundCtx, msg, args);
    } else {
      writePretty(level, module, boundCtx, msg, args);
    }
  };

  return {
    debug: (msg, ...args) => write('debug', msg, args),
    info: (msg, ...args) => write('info', msg, args),
    warn: (msg, ...args) => write('warn', msg, args),
    error: (msg, ...args) => write('error', msg, args),
    child: (ctx) => makeLogger(module, { ...boundCtx, ...ctx }),
  };
}

/**
 * Create a module-scoped logger. `prefix` becomes the `module` field on every
 * emitted line.
 */
export function createLogger(prefix: string): Logger {
  return makeLogger(prefix, {});
}

/**
 * Minimal BullMQ Job surface we read for structured context. Using a local
 * interface avoids dragging bullmq types into lib/logger.
 */
interface JobLike {
  id?: string;
  name?: string;
  queueName?: string;
  data?: unknown;
}

/**
 * Bind `traceId` / `jobId` / `queue` onto `base` from a BullMQ job. Falls
 * back to `job.id` when the payload predates traceId threading.
 */
export function loggerForJob(base: Logger, job: JobLike): Logger {
  let traceId: string | undefined;
  if (job.data && typeof job.data === 'object') {
    const t = (job.data as Record<string, unknown>).traceId;
    if (typeof t === 'string' && t.length > 0) traceId = t;
  }
  return base.child({
    traceId: traceId ?? job.id ?? 'unknown',
    jobId: job.id,
    queue: job.queueName,
  });
}

/**
 * Extract a traceId from an incoming HTTP Request. If the client passed
 * `x-trace-id` we honour it (so external systems can stitch their traces);
 * otherwise mint a fresh UUID. The returned id is safe to hand to
 * `enqueueXxx({ ..., traceId })` so the whole API-request → BullMQ chain
 * shares one id.
 */
export function traceIdFromRequest(req: { headers: { get(name: string): string | null } }): string {
  const header = req.headers.get('x-trace-id');
  if (header && header.trim().length > 0) return header.trim();
  // Node >=15 ships webcrypto; prefer it but fall back for older targets.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: time+rand (only reached on exotic runtimes).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Convenience: bind a traceId (either supplied or auto-minted from the
 * request) onto a base logger for one API request handler.
 */
export function loggerForRequest(
  base: Logger,
  req: { headers: { get(name: string): string | null } },
): { log: Logger; traceId: string } {
  const traceId = traceIdFromRequest(req);
  return { log: base.child({ traceId }), traceId };
}
