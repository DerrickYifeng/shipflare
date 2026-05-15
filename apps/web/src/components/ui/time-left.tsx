'use client';

import { useState, useEffect } from 'react';

interface TimeLeftProps {
  deadline: string;
  className?: string;
}

export function TimeLeft({ deadline, className }: TimeLeftProps) {
  // Keep both the formatted string and urgency flag in state so we don't
  // call impure `Date.now()` during render (React Compiler would flag it).
  // The interval below keeps both in sync every second.
  const [state, setState] = useState<{ text: string; urgent: boolean }>(
    { text: '', urgent: false },
  );

  useEffect(() => {
    function update() {
      const ms = new Date(deadline).getTime() - Date.now();
      if (ms <= 0) {
        setState({ text: 'Expired', urgent: false });
        return;
      }
      const mins = Math.floor(ms / 60_000);
      const secs = Math.floor((ms % 60_000) / 1000);
      setState({ text: `${mins}m ${secs}s`, urgent: ms < 5 * 60_000 });
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  return (
    <span
      className={`text-[12px] font-mono tabular-nums ${
        state.text === 'Expired'
          ? 'text-sf-error'
          : state.urgent
            ? 'text-sf-warning'
            : 'text-sf-text-tertiary'
      } ${className ?? ''}`}
    >
      {state.text}
    </span>
  );
}
