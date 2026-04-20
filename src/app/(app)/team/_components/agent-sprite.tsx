'use client';

/**
 * Single agent sprite rendered inside `OfficeScene`.
 *
 * - When idle, the character sits slightly in front of its desk and bobs via
 *   the `sf-idle-bob` keyframe.
 * - When walking (during a handoff), the character's `translate3d()` is
 *   driven by a `requestAnimationFrame` interpolator between `from` and
 *   `to` screen positions carrying a `TicketGlyph`.
 * - All motion uses compositor-friendly `transform` / `opacity` only.
 * - Reduced-motion is respected globally via the `@media (prefers-reduced-motion)`
 *   block in `globals.css`; additionally the parent clears walk state before
 *   ever handing it to this component.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { TinyCharacter } from './tiny-character';
import { TicketGlyph, type TicketKind } from './ticket-glyph';
import { StatusPill } from './status-pill';
import type { AgentEntry, SceneStatus } from './agent-roster';

export interface WalkData {
  from: { x: number; y: number };
  to: { x: number; y: number };
  ticketKind?: TicketKind;
  /** performance.now() at which the walk started. */
  startTime: number;
  /** Total walk duration in milliseconds. */
  duration: number;
}

export interface AgentSpriteProps {
  agent: AgentEntry;
  status: SceneStatus;
  /** Screen-space base position of the character when idle at the desk. */
  baseX: number;
  baseY: number;
  isWalking: boolean;
  walkData: WalkData | null;
  isSelected: boolean;
  onSelect: () => void;
  paused: boolean;
}

/** Character offset from desk center so the sprite reads as "at" the desk. */
const CHAR_OFFSET_X = 12;
const CHAR_OFFSET_Y = 8;

export function AgentSprite({
  agent,
  status,
  baseX,
  baseY,
  isWalking,
  walkData,
  isSelected,
  onSelect,
  paused,
}: AgentSpriteProps) {
  // Walk interpolation progress — drives transform3d without layout thrash.
  // We only bump state while actively walking; when idle, `walkT` stays at
  // whatever value it last held (which is fine because the render branch
  // below ignores it entirely while !isWalking).
  const [walkT, setWalkT] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isWalking || !walkData || paused) return;
    const tick = () => {
      const elapsed = performance.now() - walkData.startTime;
      const t = Math.min(1, elapsed / walkData.duration);
      setWalkT(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isWalking, walkData, paused]);

  // Live character position, facing, and z-index.
  let charX: number;
  let charY: number;
  let facingLeft = false;
  if (isWalking && walkData) {
    // When a walk begins, walkT may briefly be stale from a previous walk.
    // The first RAF tick corrects it; the single-frame offset is imperceptible.
    const t = walkT;
    charX = walkData.from.x + (walkData.to.x - walkData.from.x) * t;
    charY = walkData.from.y + (walkData.to.y - walkData.from.y) * t;
    facingLeft = walkData.to.x < walkData.from.x;
    // Vertical bob during walk (visual only).
    charY += Math.sin(t * Math.PI * 6) * 1.5;
  } else {
    charX = baseX + CHAR_OFFSET_X;
    charY = baseY + CHAR_OFFSET_Y;
  }

  const zIndex = Math.round(charY) + 1;

  const characterStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    transform: `translate3d(${charX}px, ${charY}px, 0) translate(-50%, -100%) ${facingLeft ? 'scaleX(-1)' : ''}`,
    zIndex,
    pointerEvents: 'auto',
    cursor: 'pointer',
    transition: paused ? 'opacity var(--sf-dur-base)' : 'none',
  };

  const idleWrapperStyle: CSSProperties = {
    animation: !isWalking && !paused ? 'sf-idle-bob 3.2s ease-in-out infinite' : 'none',
    animationDelay: `${(agent.desk.gx * 0.3 + agent.desk.gy * 0.2).toFixed(2)}s`,
  };

  // Floating name + status pill (hidden while walking so the label doesn't slide)
  const side = agent.labelSide;
  const dx = side === 'right' ? 42 : -42;
  const labelBaseX = baseX + CHAR_OFFSET_X + dx;
  const labelBaseY = baseY + CHAR_OFFSET_Y - 20;

  const labelStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    transform: `translate3d(${labelBaseX}px, ${labelBaseY}px, 0) translate(${side === 'right' ? '0%' : '-100%'}, -50%)`,
    zIndex: zIndex + 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: side === 'right' ? 'flex-start' : 'flex-end',
    gap: 4,
    pointerEvents: 'none',
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        aria-label={`Inspect ${agent.name} (${agent.role})`}
        style={{
          ...characterStyle,
          padding: 0,
          border: 'none',
          background: 'transparent',
          font: 'inherit',
        }}
      >
        <div style={idleWrapperStyle}>
          <TinyCharacter hue={agent.hue} walking={isWalking && !paused} />
        </div>
        {isSelected && <SelectionRing />}
        {isWalking && walkData?.ticketKind && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: '-60%',
              transform: `translateX(-40%) ${facingLeft ? 'scaleX(-1)' : ''}`,
            }}
          >
            <TicketGlyph kind={walkData.ticketKind} size={18} />
          </div>
        )}
      </button>

      {!isWalking && (
        <div style={labelStyle}>
          <span style={NAME_PILL_STYLE}>{agent.name}</span>
          <StatusPill status={status} />
        </div>
      )}
    </>
  );
}

const NAME_PILL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--sf-fg-1)',
  background: 'var(--sf-bg-primary)',
  padding: '1px 7px',
  borderRadius: 'var(--sf-radius-pill)',
  border: '1px solid var(--sf-border-subtle)',
  boxShadow: '0 1px 2px oklch(20% 0 0 / 0.08)',
  letterSpacing: 'var(--sf-track-normal)',
};

function SelectionRing() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: -4,
        transform: 'translateX(-50%)',
        width: 36,
        height: 10,
        borderRadius: '50%',
        border: '2px solid var(--sf-accent)',
        boxShadow: '0 0 0 3px oklch(70% 0.15 250 / 0.25)',
        animation: 'sf-pulse 1.4s ease-in-out infinite',
        pointerEvents: 'none',
      }}
    />
  );
}
