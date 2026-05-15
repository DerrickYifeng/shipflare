// MethodCard — Stage 1 source method picker tile. 40×40 icon tile + title + sub.
// Hover: shadow-card → shadow-card-hover + translateY(-1px).

import { useState, type ReactNode } from 'react';

interface MethodCardProps {
  icon: ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}

export function MethodCard({ icon, title, sub, onClick }: MethodCardProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: 'left',
        background: 'var(--sf-bg-secondary)',
        border: 'none',
        cursor: 'pointer',
        padding: '22px 20px',
        borderRadius: 12,
        fontFamily: 'inherit',
        boxShadow: hover
          ? 'var(--sf-shadow-card-hover)'
          : 'var(--sf-shadow-card)',
        transform: hover ? 'translateY(-1px)' : 'none',
        transition:
          'box-shadow 200ms cubic-bezier(0.16,1,0.3,1), transform 200ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'var(--sf-bg-dark-surface)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: '-0.224px',
          color: 'var(--sf-fg-1)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 13,
          lineHeight: 1.4,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-3)',
        }}
      >
        {sub}
      </div>
    </button>
  );
}
