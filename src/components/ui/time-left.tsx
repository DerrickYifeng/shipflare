'use client';

import { useState, useEffect } from 'react';

interface TimeLeftProps {
  deadline: string;
  className?: string;
}

export function TimeLeft({ deadline, className }: TimeLeftProps) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    function update() {
      const ms = new Date(deadline).getTime() - Date.now();
      if (ms <= 0) {
        setTimeLeft('Expired');
        return;
      }
      const mins = Math.floor(ms / 60_000);
      const secs = Math.floor((ms % 60_000) / 1000);
      setTimeLeft(`${mins}m ${secs}s`);
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const isUrgent = new Date(deadline).getTime() - Date.now() < 5 * 60_000;

  return (
    <span
      className={`text-[12px] font-mono tabular-nums ${
        timeLeft === 'Expired'
          ? 'text-sf-error'
          : isUrgent
            ? 'text-sf-warning'
            : 'text-sf-text-tertiary'
      } ${className ?? ''}`}
    >
      {timeLeft}
    </span>
  );
}
