'use client';

import { useState } from 'react';

interface AgentCardProps {
  name: string;
  status: 'active' | 'complete' | 'idle' | 'error';
  currentTask?: string;
  progress?: number;
  stats: Record<string, number | string>;
  cost?: number;
  duration?: number;
  log?: string[];
}

const statusConfig = {
  active: {
    indicator: '\u25CF',
    colorClass: 'text-sf-accent',
    pulseClass: 'animate-sf-pulse',
    borderClass: 'border-l-2 border-l-sf-accent',
  },
  complete: {
    indicator: '\u2713',
    colorClass: 'text-sf-success',
    pulseClass: '',
    borderClass: 'border-l-2 border-l-transparent',
  },
  error: {
    indicator: '\u25CF',
    colorClass: 'text-sf-error',
    pulseClass: '',
    borderClass: 'border-l-2 border-l-sf-error',
  },
  idle: {
    indicator: '\u25CB',
    colorClass: 'text-sf-text-tertiary',
    pulseClass: '',
    borderClass: 'border-l-2 border-l-transparent',
  },
} as const;

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
}

export function AgentCard({
  name,
  status,
  currentTask,
  progress,
  stats,
  cost,
  duration,
  log,
}: AgentCardProps) {
  const [logExpanded, setLogExpanded] = useState(false);
  const config = statusConfig[status];
  const statEntries = Object.entries(stats);
  const progressFraction = typeof progress === 'number' ? Math.min(100, Math.max(0, progress)) : 0;
  const barColor = status === 'complete' ? 'bg-sf-success' : 'bg-sf-accent';

  return (
    <div
      className={`
        bg-sf-bg-primary border border-sf-border
        rounded-[var(--radius-sf-lg)] p-4
        flex flex-col gap-3
        animate-sf-fade-in
        ${config.borderClass}
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-sf-text-primary">
          {name}
        </span>
        <span
          className={`text-[13px] leading-none ${config.colorClass} ${config.pulseClass}`}
          aria-label={`Status: ${status}`}
        >
          {config.indicator}
        </span>
      </div>

      {/* Current task */}
      {currentTask && (
        <p className="text-[13px] leading-snug text-sf-text-secondary line-clamp-2">
          {currentTask}
        </p>
      )}

      {/* Progress bar */}
      {typeof progress === 'number' && (
        <div
          className="h-[2px] w-full rounded-[var(--radius-sf-full)] bg-sf-bg-tertiary overflow-hidden"
          role="progressbar"
          aria-valuenow={progressFraction}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-[var(--radius-sf-full)] transition-all duration-500 ease-out ${barColor}`}
            style={{ width: `${progressFraction}%` }}
          />
        </div>
      )}

      {/* Stats grid */}
      {statEntries.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {statEntries.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <span className="font-mono text-[18px] font-medium leading-tight text-sf-text-primary">
                {value}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-sf-text-tertiary">
                {label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Cost and duration */}
      {(typeof cost === 'number' || typeof duration === 'number') && (
        <div className="flex items-center gap-3 font-mono text-[11px] text-sf-text-tertiary">
          {typeof cost === 'number' && <span>{formatCost(cost)}</span>}
          {typeof cost === 'number' && typeof duration === 'number' && (
            <span aria-hidden="true">/</span>
          )}
          {typeof duration === 'number' && <span>{formatDuration(duration)}</span>}
        </div>
      )}

      {/* Expandable log */}
      {log && log.length > 0 && (
        <div className="border-t border-sf-border pt-2 -mx-4 px-4">
          <button
            type="button"
            onClick={() => setLogExpanded((prev) => !prev)}
            className="
              flex items-center gap-1.5
              text-[11px] font-mono text-sf-text-tertiary
              hover:text-sf-text-secondary
              transition-colors duration-150
              cursor-pointer min-h-[32px]
            "
            aria-expanded={logExpanded}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              className={`transition-transform duration-150 ${logExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            LOG ({log.length})
          </button>
          {logExpanded && (
            <div className="mt-1 animate-sf-fade-in">
              <div
                className="
                  max-h-[120px] overflow-y-auto
                  bg-sf-bg-secondary rounded-[var(--radius-sf-sm)] p-2
                  flex flex-col gap-0.5
                "
              >
                {log.map((entry, i) => (
                  <span
                    key={i}
                    className="font-mono text-[11px] leading-relaxed text-sf-text-secondary block"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
