import pc from 'picocolors';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getThreshold(): number {
  return LEVELS[process.env.LOG_LEVEL as LogLevel] ?? LEVELS.info;
}

function ts(): string {
  return pc.dim(new Date().toISOString().slice(11, 23));
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: pc.dim('DBG'),
  info: pc.cyan('INF'),
  warn: pc.yellow('WRN'),
  error: pc.red('ERR'),
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(prefix: string): Logger {
  const tag = pc.bold(`[${prefix}]`);

  const write = (level: LogLevel, msg: string, args: unknown[]) => {
    if (LEVELS[level] < getThreshold()) return;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(`${ts()} ${LEVEL_LABELS[level]} ${tag} ${msg}`, ...args);
  };

  return {
    debug: (msg, ...args) => write('debug', msg, args),
    info: (msg, ...args) => write('info', msg, args),
    warn: (msg, ...args) => write('warn', msg, args),
    error: (msg, ...args) => write('error', msg, args),
  };
}
