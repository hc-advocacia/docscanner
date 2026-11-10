import type { Corner } from '@devantage/docscanify';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Loupe } from './Loupe';

/** One drawing call on the fake context, with the stroke style in effect for strokes. */
type Call = [string, ...(number | string | HTMLImageElement)[]];

/** Records what the loupe draws, since jsdom has no canvas pixels. */
class RecordingContext {
  public calls: Call[] = [];
  public fillStyle: string = '';
  public strokeStyle: string = '';
  public lineWidth: number = 0;
  public lineJoin: string = '';
  public imageSmoothingEnabled: boolean = false;

  public fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(['fillRect', x, y, w, h, this.fillStyle]);
  }

  public drawImage(image: HTMLImageElement, ...args: number[]): void {
    this.calls.push(['drawImage', image, ...args]);
  }

  public beginPath(): void {
    this.calls.push(['beginPath']);
  }

  public moveTo(x: number, y: number): void {
    this.calls.push(['moveTo', x, y]);
  }

  public lineTo(x: number, y: number): void {
    this.calls.push(['lineTo', x, y]);
  }

  public stroke(): void {
    this.calls.push(['stroke', this.lineWidth, this.strokeStyle]);
  }

  /** Calls of one kind, without the name. */
  public of(name: string): Call[] {
    return this.calls
      .filter((call: Call) => call[0] === name)
      .map((call: Call): Call => call.slice(1) as Call);
  }
}

// A 400 × 600 image with the crop inside it, in outline order (TL, TR, BR, BL)
const OUTLINE: Corner[] = [
  { x: 100, y: 200 },
  { x: 300, y: 200 },
  { x: 300, y: 400 },
  { x: 100, y: 400 },
];

let context: RecordingContext;
let image: HTMLImageElement;

beforeEach((): void => {
  context = new RecordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (): RenderingContext => context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('devicePixelRatio', 1);
  image = document.createElement('img');
});

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('Loupe', (): void => {
  it('is a decorative canvas of the given size at the given position', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 84, y: 12 }}
      />,
    );

    const loupe: HTMLCanvasElement = screen.getByTestId('loupe');
    expect(loupe.tagName).toBe('CANVAS');
    expect(loupe).toHaveAttribute('aria-hidden', 'true');
    expect(loupe).toHaveClass('loupe');
    expect(loupe.style.width).toBe('128px');
    expect(loupe.style.height).toBe('128px');
    expect(loupe.style.left).toBe('84px');
    expect(loupe.style.top).toBe('12px');
    expect(loupe.width).toBe(128);
    expect(loupe.height).toBe(128);
  });

  it('draws the image area around the dragged corner, magnified 2.5 times', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    // Background first, then the image: 128 / 2.5 = 51.2 image units centered on (100, 200)
    expect(context.of('fillRect')).toEqual([[0, 0, 128, 128, '#f3ebe2']]);
    const draws: Call[] = context.of('drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0][0]).toBe(image);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = draws[0].slice(1) as number[];
    expect(sx).toBeCloseTo(74.4);
    expect(sy).toBeCloseTo(174.4);
    expect(sw).toBeCloseTo(51.2);
    expect(sh).toBeCloseTo(51.2);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 128, 128]);
    expect(context.imageSmoothingEnabled).toBe(true);
  });

  it('shows more of the image when each screen pixel covers more image units', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={2}
        unit={2}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    const [sx, sy, sw, sh] = context.of('drawImage')[0].slice(1) as number[];
    // 128 × 2 / 2.5 = 102.4 image units, centered on the bottom-right corner (300, 400)
    expect(sw).toBeCloseTo(102.4);
    expect(sh).toBeCloseTo(102.4);
    expect(sx).toBeCloseTo(248.8);
    expect(sy).toBeCloseTo(348.8);
  });

  it('draws the two edges that meet at the corner, a white halo then the copper line', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    // 2.5 canvas px per image unit; the corner sits at the center (64, 64). From the previous
    // corner (bottom-left) through the corner to the next one (top-right)
    const edge: number[][] = [
      [64, 564],
      [64, 64],
      [564, 64],
    ];
    expect(context.of('stroke')).toEqual([
      [5, '#ffffff'],
      [2.5, '#8a4e30'],
      [1, 'rgba(42,28,20,.85)'],
    ]);
    expect(context.lineJoin).toBe('round');
    const moves: Call[] = context.of('moveTo');
    const lines: Call[] = context.of('lineTo');
    expect(moves.slice(0, 2)).toEqual([edge[0], edge[0]]);
    expect(lines.slice(0, 4)).toEqual([edge[1], edge[2], edge[1], edge[2]]);
  });

  it('draws a crosshair on the exact corner', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={1}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    // After the two edge strokes: a horizontal then a vertical line of 20 px through the center
    expect(context.of('moveTo').slice(2)).toEqual([
      [54, 64],
      [64, 54],
    ]);
    expect(context.of('lineTo').slice(4)).toEqual([
      [74, 64],
      [64, 74],
    ]);
  });

  it('centers the edges on the corner being dragged', (): void => {
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={1}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    // Top-right corner: from the top-left (200 units to the left) to the bottom-right (below)
    expect(context.of('moveTo')[0]).toEqual([-436, 64]);
    expect(context.of('lineTo').slice(0, 2)).toEqual([
      [64, 64],
      [64, 564],
    ]);
  });

  it('renders at the device pixel ratio, with lines of the same on-screen width', (): void => {
    vi.stubGlobal('devicePixelRatio', 2);
    render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    const loupe: HTMLCanvasElement = screen.getByTestId('loupe');
    expect(loupe.width).toBe(256);
    expect(loupe.height).toBe(256);
    expect(loupe.style.width).toBe('128px');
    expect(context.of('stroke')).toEqual([
      [10, '#ffffff'],
      [5, '#8a4e30'],
      [2, 'rgba(42,28,20,.85)'],
    ]);
    expect(context.of('moveTo').slice(2)).toEqual([
      [108, 128],
      [128, 108],
    ]);
  });

  it('draws again when another corner is dragged', (): void => {
    const { rerender } = render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );
    context.calls = [];

    rerender(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={3}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );

    const [sx, sy] = context.of('drawImage')[0].slice(1) as number[];
    // Bottom-left corner (100, 400)
    expect(sx).toBeCloseTo(74.4);
    expect(sy).toBeCloseTo(374.4);
  });

  it('does not draw again when only its position changes', (): void => {
    const { rerender } = render(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 0, y: 0 }}
      />,
    );
    context.calls = [];

    rerender(
      <Loupe
        image={image}
        outline={OUTLINE}
        index={0}
        unit={1}
        size={128}
        position={{ x: 50, y: 60 }}
      />,
    );

    expect(context.calls).toEqual([]);
    expect(screen.getByTestId('loupe').style.left).toBe('50px');
  });
});
