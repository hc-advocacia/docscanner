import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { PdfPagePreview } from '@/lib/export';

import { ResultPreview } from './ResultPreview';

type DrawImage = Mock<
  (image: CanvasImageSource, x: number, y: number, ...size: number[]) => void
>;

/** A drawing call on the preview context, with the styles set when it ran. */
interface DrawCall {
  name: 'fillRect' | 'strokeRect' | 'drawImage';
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  lineDash: number[];
}

let drawImage: DrawImage;
let drawCalls: DrawCall[];
let getContext: Mock<(this: HTMLCanvasElement) => unknown>;

/**
 * A stand-in 2D context that records the drawing calls in order, each with the styles set at that
 * moment. `drawImage` also goes to the {@link drawImage} mock.
 */
function recordingContext(canvas: HTMLCanvasElement): Record<string, unknown> {
  const context: Record<string, unknown> = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineDash: [] as number[],
    setLineDash(segments: number[]): void {
      context.lineDash = segments;
    },
  };
  const record =
    (name: DrawCall['name']): ((...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      drawCalls.push({
        name,
        args,
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
        lineDash: context.lineDash as number[],
      });
    };
  context.fillRect = record('fillRect');
  context.strokeRect = record('strokeRect');
  context.drawImage = (...args: unknown[]): void => {
    record('drawImage')(...args);
    (drawImage as unknown as (...drawArgs: unknown[]) => void)(...args);
  };
  return context;
}

/**
 * A 200 × 400 pt page with the document 160 × 280 pt at (20, 60) pt, inside margins of
 * `margin` pt.
 */
function pagePreview(margin: number): PdfPagePreview {
  return {
    pageFormat: 'letter',
    layout: {
      page: { width: 200, height: 400 },
      image: { x: 20, y: 60, width: 160, height: 280 },
    },
    margin,
  };
}

/** A rendered document of the given size, as {@link useRenderedDocument} returns it. */
function renderedCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas: HTMLCanvasElement = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

beforeEach((): void => {
  drawImage = vi.fn();
  drawCalls = [];
  getContext = vi.fn(function (this: HTMLCanvasElement): unknown {
    return recordingContext(this);
  });
  // jsdom has no canvas pixels: the drawing is recorded instead
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    getContext as unknown as HTMLCanvasElement['getContext'],
  );
});

describe('ResultPreview', (): void => {
  it('shows nothing before the first render', (): void => {
    render(
      <ResultPreview
        result={null}
        busy={false}
        rendering={false}
        label="Preview of document 1, cropped"
        filter="none"
      />,
    );

    expect(screen.queryByTestId('result')).not.toBeInTheDocument();
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('shows only the spinner while the first render runs', (): void => {
    render(
      <ResultPreview
        result={null}
        busy
        rendering
        label="Preview of document 1, cropped"
        filter="none"
      />,
    );

    expect(screen.queryByTestId('result')).not.toBeInTheDocument();
    expect(screen.getByTestId('loading')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('copies the rendered document, at its size, into an image with the given name', (): void => {
    const result: HTMLCanvasElement = renderedCanvas(640, 900);
    render(
      <ResultPreview
        result={result}
        busy={false}
        rendering={false}
        label="Preview of document 2, cropped"
        filter="bw"
      />,
    );

    const preview: HTMLCanvasElement = screen.getByRole('img', {
      name: 'Preview of document 2, cropped',
    });
    expect(preview).toBe(screen.getByTestId('result'));
    expect(preview).not.toBe(result);
    expect(preview.width).toBe(640);
    expect(preview.height).toBe(900);
    expect(preview).toHaveAttribute('data-filter', 'bw');
    expect(preview).toHaveClass('result');
    expect(preview).not.toHaveClass('is-busy');
    expect(preview).not.toHaveAttribute('data-page-format');
    expect(preview).not.toHaveClass('is-page');
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(result, 0, 0);
    expect(drawCalls.map((call: DrawCall): string => call.name)).toEqual([
      'drawImage',
    ]);
    expect(getContext.mock.contexts.at(-1)).toBe(preview);
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  describe('on a PDF page', (): void => {
    it('draws a white page as large as the render along its longest side, with the render where the PDF puts it', (): void => {
      // 560 px along the 400 pt height: 1.4 px per point
      const result: HTMLCanvasElement = renderedCanvas(320, 560);
      render(
        <ResultPreview
          result={result}
          busy={false}
          rendering={false}
          label="Preview of document 1 as a PDF (Letter)"
          filter="none"
          page={pagePreview(0)}
        />,
      );

      const preview: HTMLCanvasElement = screen.getByRole('img', {
        name: 'Preview of document 1 as a PDF (Letter)',
      });
      expect(preview).toBe(screen.getByTestId('result'));
      expect(preview.width).toBe(280);
      expect(preview.height).toBe(560);
      expect(preview).toHaveAttribute('data-page-format', 'letter');
      expect(preview).toHaveClass('result', 'is-page');
      expect(getContext.mock.contexts.at(-1)).toBe(preview);
      // Without margins, no guide: the page, then the render
      expect(drawCalls).toEqual([
        expect.objectContaining({
          name: 'fillRect',
          args: [0, 0, 280, 560],
          fillStyle: '#fff',
        }),
        expect.objectContaining({ name: 'drawImage' }),
      ]);
      const [image, x, y, width, height] = drawImage.mock.calls[0];
      expect(image).toBe(result);
      expect(x).toBeCloseTo(28, 10);
      expect(y).toBeCloseTo(84, 10);
      expect(width).toBeCloseTo(224, 10);
      expect(height).toBeCloseTo(392, 10);
    });

    it('caps the page to the longest side of the render, however small the document is on it', (): void => {
      // A document 2 pt wide on the page, as wide margins make it
      const result: HTMLCanvasElement = renderedCanvas(1000, 500);
      render(
        <ResultPreview
          result={result}
          busy={false}
          rendering={false}
          label="Preview"
          filter="none"
          page={{
            pageFormat: 'a4',
            layout: {
              page: { width: 841.89, height: 595.28 },
              image: { x: 419.945, y: 297.14, width: 2, height: 1 },
            },
            margin: 283.46,
          }}
        />,
      );

      const preview: HTMLCanvasElement = screen.getByTestId('result');
      expect(preview.width).toBe(1000);
      expect(preview.height).toBe(Math.round((595.28 * 1000) / 841.89));
      const [, , , width, height] = drawImage.mock.calls[0];
      expect(width).toBeCloseTo((2 * 1000) / 841.89, 10);
      expect(height).toBeCloseTo(1000 / 841.89, 10);
    });

    it('draws a thin dashed guide along the margins, in the margin area, under the render', (): void => {
      render(
        <ResultPreview
          result={renderedCanvas(320, 560)}
          busy={false}
          rendering={false}
          label="Preview"
          filter="none"
          page={pagePreview(10)}
        />,
      );

      expect(drawCalls.map((call: DrawCall): string => call.name)).toEqual([
        'fillRect',
        'strokeRect',
        'drawImage',
      ]);
      const guide: DrawCall = drawCalls[1];
      const lineWidth: number = guide.lineWidth as number;
      expect(lineWidth).toBeGreaterThanOrEqual(1);
      expect(lineWidth).toBeLessThan(3);
      expect(guide.strokeStyle).toBe('#d4c1af');
      expect(guide.lineDash).toHaveLength(2);
      expect(guide.lineDash.every((dash: number): boolean => dash > 0)).toBe(
        true,
      );
      // 10 pt = 14 px from each edge; the line ends there, on the margin side
      const inset: number = 14 - lineWidth / 2;
      const [x, y, width, height] = guide.args as number[];
      expect(x).toBeCloseTo(inset, 10);
      expect(y).toBeCloseTo(inset, 10);
      expect(width).toBeCloseTo(280 - inset * 2, 10);
      expect(height).toBeCloseTo(560 - inset * 2, 10);
    });

    it('draws again when the page changes, and goes back to the plain render without one', (): void => {
      const result: HTMLCanvasElement = renderedCanvas(320, 560);
      const { rerender } = render(
        <ResultPreview
          result={result}
          busy={false}
          rendering={false}
          label="Preview"
          filter="none"
          page={pagePreview(0)}
        />,
      );

      rerender(
        <ResultPreview
          result={result}
          busy={false}
          rendering={false}
          label="Preview"
          filter="none"
          page={pagePreview(10)}
        />,
      );
      expect(
        drawCalls.filter(
          (call: DrawCall): boolean => call.name === 'strokeRect',
        ),
      ).toHaveLength(1);

      rerender(
        <ResultPreview
          result={result}
          busy={false}
          rendering={false}
          label="Preview"
          filter="none"
        />,
      );
      const preview: HTMLCanvasElement = screen.getByTestId('result');
      expect(preview.width).toBe(320);
      expect(preview.height).toBe(560);
      expect(preview).not.toHaveAttribute('data-page-format');
      expect(preview).not.toHaveClass('is-page');
      expect(drawImage).toHaveBeenCalledTimes(3);
      expect(drawImage.mock.calls[2]).toEqual([result, 0, 0]);
    });

    it('fades the page of an out-of-date render', (): void => {
      render(
        <ResultPreview
          result={renderedCanvas(320, 560)}
          busy
          rendering
          label="Preview"
          filter="none"
          page={pagePreview(0)}
        />,
      );

      expect(screen.getByTestId('result')).toHaveClass('is-page', 'is-busy');
      expect(screen.getByTestId('loading')).toBeInTheDocument();
    });
  });

  it('fades an out-of-date render and shows the spinner while the new one runs', (): void => {
    render(
      <ResultPreview
        result={renderedCanvas(10, 10)}
        busy
        rendering
        label="Preview of document 1, cropped"
        filter="grayscale"
      />,
    );

    expect(screen.getByTestId('result')).toHaveClass('result', 'is-busy');
    expect(screen.getByTestId('loading')).toBeInTheDocument();
  });

  it('shows the spinner while some render runs, even over an up-to-date preview', (): void => {
    render(
      <ResultPreview
        result={renderedCanvas(10, 10)}
        busy={false}
        rendering
        label="Preview of document 1, cropped"
        filter="none"
      />,
    );

    expect(screen.getByTestId('result')).not.toHaveClass('is-busy');
    expect(screen.getByTestId('loading')).toBeInTheDocument();
  });

  it('fades an out-of-date render without a spinner when no render runs', (): void => {
    render(
      <ResultPreview
        result={renderedCanvas(10, 10)}
        busy
        rendering={false}
        label="Preview of document 1, cropped"
        filter="none"
      />,
    );

    expect(screen.getByTestId('result')).toHaveClass('is-busy');
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('draws the new render when it arrives', (): void => {
    const first: HTMLCanvasElement = renderedCanvas(100, 200);
    const { rerender } = render(
      <ResultPreview
        result={first}
        busy={false}
        rendering={false}
        label="Preview"
        filter="none"
      />,
    );
    const second: HTMLCanvasElement = renderedCanvas(300, 150);

    rerender(
      <ResultPreview
        result={second}
        busy={false}
        rendering={false}
        label="Preview"
        filter="none"
      />,
    );

    const preview: HTMLCanvasElement = screen.getByTestId('result');
    expect(preview.width).toBe(300);
    expect(preview.height).toBe(150);
    expect(drawImage.mock.calls).toEqual([
      [first, 0, 0],
      [second, 0, 0],
    ]);
  });

  it('does not draw again when only the busy state changes', (): void => {
    const result: HTMLCanvasElement = renderedCanvas(100, 200);
    const { rerender } = render(
      <ResultPreview
        result={result}
        busy={false}
        rendering={false}
        label="Preview"
        filter="none"
      />,
    );

    rerender(
      <ResultPreview
        result={result}
        busy
        rendering
        label="Preview"
        filter="none"
      />,
    );

    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});
