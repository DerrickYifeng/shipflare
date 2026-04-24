import type { CSSProperties, ReactNode } from 'react';

export interface TodaysOutputProps {
  /** team_tasks rows with status='completed' this week. */
  completedTasks: number | string;
  /** team_members.status='waiting_approval' count. */
  awaitingApproval: number | string;
  /** team_tasks rows with status in {pending, running}. */
  tasksInFlight: number | string;
  /** Voice-match score (stubbed "—" until the writer pipeline lands). */
  voiceMatch: number | string;
}

export function TodaysOutput({
  completedTasks,
  awaitingApproval,
  tasksInFlight,
  voiceMatch,
}: TodaysOutputProps) {
  const wrap: CSSProperties = {
    marginTop: 14,
    padding: 14,
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
  };

  const header: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'rgba(0, 0, 0, 0.48)',
    marginBottom: 10,
  };

  const grid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
  };

  return (
    <section style={wrap} aria-label="This week at a glance">
      <div style={header}>This week</div>
      <div style={grid}>
        <OutputCell value={completedTasks} label="Completed tasks" />
        <OutputCell value={awaitingApproval} label="Awaiting you" />
        <OutputCell value={tasksInFlight} label="Tasks in flight" />
        <OutputCell value={voiceMatch} label="Voice match" />
      </div>
    </section>
  );
}

interface OutputCellProps {
  value: ReactNode;
  label: string;
}

function OutputCell({ value, label }: OutputCellProps) {
  const cell: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  };
  const valueStyle: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 20,
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.01em',
  };
  const labelStyle: CSSProperties = {
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.48)',
    letterSpacing: '-0.08px',
  };
  return (
    <div style={cell}>
      <span style={valueStyle}>{value}</span>
      <span style={labelStyle}>{label}</span>
    </div>
  );
}
