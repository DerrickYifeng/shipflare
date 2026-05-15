// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline } from '../sparkline';

describe('Sparkline', () => {
  it('renders an SVG with one polyline', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4, 5]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('polyline').length).toBe(1);
  });

  it('renders an empty SVG when values is empty', () => {
    const { container } = render(<Sparkline values={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('polyline')).toBeNull();
  });

  it('normalizes points so min maps to bottom and max to top of viewBox', () => {
    const { container } = render(<Sparkline values={[0, 10]} width={100} height={20} />);
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const points = poly!.getAttribute('points')!;
    // 2 points: first at y=20 (min), second at y=0 (max), spread across x
    const parsed = points
      .split(' ')
      .map((p) => p.split(',').map(Number)) as [number, number][];
    expect(parsed.length).toBe(2);
    expect(parsed[0][1]).toBeCloseTo(20, 1);
    expect(parsed[1][1]).toBeCloseTo(0, 1);
  });

  it('handles all-zero series by rendering a flat baseline', () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} height={20} />);
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const ys = poly!
      .getAttribute('points')!
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
    expect(new Set(ys).size).toBe(1); // all same y
  });
});
