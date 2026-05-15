// BackLink — small in-content "← Pick a different method" style link.
// Distinct from TopChevron (which sits on the shell above WorkArea).

import { ArrowLeft } from '../icons';

interface BackLinkProps {
  onClick: () => void;
  label: string;
}

export function BackLink({ onClick, label }: BackLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: 'var(--sf-fg-4)',
        letterSpacing: '-0.12px',
        marginBottom: 16,
      }}
    >
      <ArrowLeft size={12} /> {label}
    </button>
  );
}
