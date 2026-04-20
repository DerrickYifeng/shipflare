/**
 * Diamond-tile isometric floor. Renders inside the scene SVG, which already
 * applies the `translate(cx, cy)` transform so tile `(0,0)` sits top-center.
 */

import { TILE_H, TILE_W, isoToXY } from './agent-roster';

export interface IsoFloorProps {
  cols?: number;
  rows?: number;
}

interface TileSpec {
  x: number;
  y: number;
  parity: number;
  key: string;
}

function buildTiles(cols: number, rows: number): TileSpec[] {
  const tiles: TileSpec[] = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const { x, y } = isoToXY(gx, gy);
      tiles.push({ x, y, parity: (gx + gy) % 2, key: `${gx}:${gy}` });
    }
  }
  return tiles;
}

export function IsoFloor({ cols = 7, rows = 5 }: IsoFloorProps) {
  const tiles = buildTiles(cols, rows);
  return (
    <g>
      {tiles.map(({ x, y, parity, key }) => (
        <polygon
          key={key}
          points={`${x},${y - TILE_H} ${x + TILE_W},${y} ${x},${y + TILE_H} ${x - TILE_W},${y}`}
          fill={parity === 0 ? 'oklch(94% 0.006 60)' : 'oklch(96% 0.004 60)'}
          stroke="oklch(88% 0.005 60)"
          strokeWidth="0.75"
        />
      ))}
    </g>
  );
}
