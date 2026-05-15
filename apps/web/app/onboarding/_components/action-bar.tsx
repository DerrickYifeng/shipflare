// ActionBar — bottom flex row: back + extras + spacer + primary with arrow.
// Stages compose `<ActionBar>` with OnbButton children.

import type { ReactNode } from 'react';

interface ActionBarProps {
  back?: ReactNode;
  extras?: ReactNode;
  primary: ReactNode;
  marginTop?: number;
}

export function ActionBar({
  back,
  extras,
  primary,
  marginTop = 32,
}: ActionBarProps) {
  return (
    <div
      style={{
        marginTop,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {back}
      {extras}
      <span style={{ flex: 1 }} />
      {primary}
    </div>
  );
}
