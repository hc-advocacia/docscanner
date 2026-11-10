import type { Corner } from '@devantage/docscanify';
import { type JSX, type RefObject, useEffect, useRef } from 'react';

/** Magnification relative to what is on screen. */
const ZOOM: number = 2.5;

interface Props {
  image: HTMLImageElement;
  /** The four corners, in outline order and image coordinates. */
  outline: Corner[];
  /** Index of the corner being dragged: the loupe centers on it. */
  index: number;
  /** Image units per screen pixel. */
  unit: number;
  /** Diameter, in screen px. */
  size: number;
  /** Top-left corner, in px from the editor. */
  position: Corner;
}

/**
 * Magnified view of the area around the corner being dragged, with the two crop edges that meet
 * at it and a crosshair on the exact point.
 */
export function Loupe({
  image,
  outline,
  index,
  unit,
  size,
  position,
}: Props): JSX.Element {
  const ref: RefObject<HTMLCanvasElement | null> =
    useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas: HTMLCanvasElement | null = ref.current;
    if (!canvas) return;
    const dpr: number = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) throw new Error('The loupe canvas has no 2D context');
    const c: Corner = outline[index];
    const span: number = (size * unit) / ZOOM; // image area shown
    const s: number = canvas.width / span; // canvas px per image unit
    const tx = (p: Corner): Corner => ({
      x: (p.x - c.x) * s + canvas.width / 2,
      y: (p.y - c.y) * s + canvas.height / 2,
    });

    ctx.fillStyle = '#f3ebe2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      image,
      c.x - span / 2,
      c.y - span / 2,
      span,
      span,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const prev: Corner = tx(outline[(index + 3) % 4]);
    const next: Corner = tx(outline[(index + 1) % 4]);
    const mid: Corner = tx(c);
    // Copper with a white halo, like the editor: visible on light and dark photos
    ctx.lineJoin = 'round';
    for (const [width, color] of [
      [5, '#ffffff'],
      [2.5, '#8a4e30'],
    ] as const) {
      ctx.lineWidth = width * dpr;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(mid.x, mid.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(42,28,20,.85)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(mid.x - 10 * dpr, mid.y);
    ctx.lineTo(mid.x + 10 * dpr, mid.y);
    ctx.moveTo(mid.x, mid.y - 10 * dpr);
    ctx.lineTo(mid.x, mid.y + 10 * dpr);
    ctx.stroke();
  }, [image, outline, index, unit, size]);

  return (
    <canvas
      ref={ref}
      className="loupe"
      style={{ width: size, height: size, left: position.x, top: position.y }}
      data-testid="loupe"
      aria-hidden
    />
  );
}
