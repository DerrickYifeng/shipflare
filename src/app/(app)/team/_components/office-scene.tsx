'use client';

/**
 * Isometric office scene — the hero of the `/team` route.
 *
 * Layout strategy:
 *   The scene is drawn at a fixed 720×480 coordinate space. An HTML overlay
 *   hosts every desk, character, and floating label so we can use `transform`
 *   animations without fighting SVG. The overlay is scaled to container width
 *   via a `ResizeObserver` so positions stay pixel-accurate at any size.
 *
 * Motion:
 *   - Walk / idle animations use `transform` + `opacity` only.
 *   - Reduced motion is honored via the global `prefers-reduced-motion` block
 *     in `globals.css`; this component additionally skips RAF interpolation
 *     by passing `paused` through when motion is disabled.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { StatusDot } from '@/components/ui/status-dot';
import { IsoFloor } from './iso-floor';
import { IsoDesk } from './iso-desk';
import { AgentSprite, type WalkData } from './agent-sprite';
import { PauseOverlay } from './pause-overlay';
import {
  AGENT_ROSTER,
  TILE_H,
  TILE_W,
  isoToXY,
  type AgentEntry,
  type AgentId,
  type SceneStatus,
} from './agent-roster';

export interface OfficeSceneProps {
  statuses: Record<AgentId, SceneStatus>;
  selectedId: AgentId | null;
  onSelectAgent: (id: AgentId) => void;
  paused: boolean;
  /** Called when the PauseOverlay is clicked / activated. */
  onResume?: () => void;
  /** When non-null, the given agent's character walks along `walk` instead
   *  of sitting at its desk. */
  walkingAgentId: AgentId | null;
  walkData: WalkData | null;
  /** Tally — used inside the little "Pipeline · RUNNING" badge. */
  activeCount: number;
}

const SCENE_W = 720;
const SCENE_H = 480;

export function OfficeScene({
  statuses,
  selectedId,
  onSelectAgent,
  paused,
  onResume,
  walkingAgentId,
  walkData,
  activeCount,
}: OfficeSceneProps) {
  const cx = SCENE_W / 2;
  const cy = SCENE_H * 0.42;

  const outerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  // Scale the HTML overlay to match the responsive container width.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / SCENE_W);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Back-to-front render order so overlapping characters paint correctly.
  const sortedAgents = useMemo<AgentEntry[]>(
    () =>
      [...AGENT_ROSTER].sort(
        (a, b) => a.desk.gx + a.desk.gy - (b.desk.gx + b.desk.gy),
      ),
    [],
  );

  const outerStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    aspectRatio: `${SCENE_W} / ${SCENE_H}`,
    background:
      'radial-gradient(ellipse at center top, oklch(97% 0.005 60) 0%, oklch(93% 0.008 60) 100%)',
    borderRadius: 'var(--sf-radius-lg)',
    overflow: 'hidden',
    border: '1px solid var(--sf-border-subtle)',
    boxShadow: 'var(--sf-shadow-card-hover)',
  };

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SCENE_W,
    height: SCENE_H,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    pointerEvents: 'none',
  };

  const backWall = useMemo(() => {
    const leftStart = isoToXY(0, 0);
    const rightStart = isoToXY(7, 0);
    return `${leftStart.x - TILE_W},${leftStart.y - TILE_H - 40}
            ${leftStart.x - TILE_W},${leftStart.y - TILE_H}
            ${rightStart.x + TILE_W},${rightStart.y - TILE_H}
            ${rightStart.x + TILE_W},${rightStart.y - TILE_H - 40}`;
  }, []);

  return (
    <div ref={outerRef} style={outerStyle}>
      {/* Floor + back-wall hint as SVG (cheap, no animation here). */}
      <svg
        viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <g transform={`translate(${cx} ${cy})`}>
          <IsoFloor cols={7} rows={5} />
          <polygon points={backWall} fill="oklch(96% 0.005 60)" opacity="0.5" />
        </g>
      </svg>

      {/* HTML overlay: every desk + character lives here so we can animate
          `transform` cleanly. */}
      <div style={overlayStyle}>
        {sortedAgents.map((agent) => {
          const { x, y } = isoToXY(agent.desk.gx, agent.desk.gy);
          const screenX = cx + x;
          const screenY = cy + y;
          const isWalking = walkingAgentId === agent.id;
          const status = statuses[agent.id];

          const deskStyle: CSSProperties = {
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -90%)`,
            zIndex: Math.round(screenY),
          };

          return (
            <div key={agent.id}>
              <div style={deskStyle}>
                <IsoDesk hue={agent.hue} active={status !== 'idle'} />
              </div>
              <AgentSprite
                agent={agent}
                status={status}
                baseX={screenX}
                baseY={screenY}
                isWalking={isWalking}
                walkData={isWalking ? walkData : null}
                isSelected={selectedId === agent.id}
                onSelect={() => onSelectAgent(agent.id)}
                paused={paused}
              />
            </div>
          );
        })}
      </div>

      <ScenePill paused={paused} activeCount={activeCount} totalCount={AGENT_ROSTER.length} />

      {paused && onResume && <PauseOverlay onResume={onResume} />}
    </div>
  );
}

interface ScenePillProps {
  paused: boolean;
  activeCount: number;
  totalCount: number;
}

function ScenePill({ paused, activeCount, totalCount }: ScenePillProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 14,
        left: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'var(--sf-bg-primary)',
        border: '1px solid var(--sf-border-subtle)',
        borderRadius: 'var(--sf-radius-pill)',
        boxShadow: 'var(--sf-shadow-card)',
        pointerEvents: 'none',
      }}
    >
      <StatusDot state={paused ? 'idle' : 'active'} />
      <span
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-xs)',
          letterSpacing: 'var(--sf-track-mono)',
          color: 'var(--sf-fg-2)',
          fontWeight: 600,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {paused ? 'PIPELINE · PAUSED' : 'PIPELINE · RUNNING'}
      </span>
      <span
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-xs)',
          letterSpacing: 'var(--sf-track-mono)',
          color: 'var(--sf-fg-3)',
          whiteSpace: 'nowrap',
        }}
      >
        · {activeCount} / {totalCount} active
      </span>
    </div>
  );
}
