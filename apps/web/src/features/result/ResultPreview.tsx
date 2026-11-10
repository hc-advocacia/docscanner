import { type JSX, type RefObject, useLayoutEffect, useRef } from 'react';

import { Spinner } from '@/components/Spinner';
import type { PdfPagePreview } from '@/lib/export';

interface Props {
  /** Rendered document; nothing shows up before the first one. */
  result: HTMLCanvasElement | null;
  /** `result` is out of date and a new render is on its way: it shows faded. */
  busy: boolean;
  /** Shows the loading spinner. */
  rendering: boolean;
  /** Accessible name of the preview. */
  label: string;
  /** Color filter of the document, exposed as `data-filter`. */
  filter: string;
  /** Shows the document on this PDF page instead of on its own. */
  page?: PdfPagePreview;
}

const PAGE_COLOR: string = '#fff';

/**
 * Light enough to stay in the background, dark enough to show on a white document. Same warm tone
 * as `--line-strong`.
 */
const MARGIN_GUIDE_COLOR: string = '#d4c1af';

/** Width of the margin guide, as a share of the longest side of the page. */
const MARGIN_GUIDE_WIDTH: number = 0.0015;

/**
 * Gets the 2D context of a canvas.
 *
 * @throws When the browser gives no 2D context.
 */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D canvas context');
  return context;
}

/** Copies the rendered document into the preview canvas, at its size. */
function drawDocument(
  canvas: HTMLCanvasElement,
  result: HTMLCanvasElement,
): void {
  canvas.width = result.width;
  canvas.height = result.height;
  context2d(canvas).drawImage(result, 0, 0);
}

/**
 * Draws a white PDF page with the rendered document where the PDF puts it and, when the page has
 * margins, a dashed guide along them, inside the margin area. The guide only helps to see the
 * margins on a white document; the PDF has none. The canvas is as large as the render along its
 * longest side, so a wide margin, which shrinks the document on the page, cannot make a huge
 * canvas.
 */
function drawPage(
  canvas: HTMLCanvasElement,
  result: HTMLCanvasElement,
  { layout, margin }: PdfPagePreview,
): void {
  const pixelsPerPoint: number =
    Math.max(result.width, result.height) /
    Math.max(layout.page.width, layout.page.height);
  canvas.width = Math.round(layout.page.width * pixelsPerPoint);
  canvas.height = Math.round(layout.page.height * pixelsPerPoint);
  const context: CanvasRenderingContext2D = context2d(canvas);
  context.fillStyle = PAGE_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (margin > 0) {
    const lineWidth: number = Math.max(
      1,
      Math.max(canvas.width, canvas.height) * MARGIN_GUIDE_WIDTH,
    );
    // Centered half a line outside the margin: the whole line lies in the margin area, where the
    // document never covers it
    const inset: number = margin * pixelsPerPoint - lineWidth / 2;
    context.strokeStyle = MARGIN_GUIDE_COLOR;
    context.lineWidth = lineWidth;
    context.setLineDash([lineWidth * 4, lineWidth * 3]);
    context.strokeRect(
      inset,
      inset,
      canvas.width - inset * 2,
      canvas.height - inset * 2,
    );
  }

  const { image } = layout;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    result,
    image.x * pixelsPerPoint,
    image.y * pixelsPerPoint,
    image.width * pixelsPerPoint,
    image.height * pixelsPerPoint,
  );
}

/**
 * The rendered document, centered in the stage, with a spinner while a render runs. With a `page`,
 * it shows the document on that PDF page, as the PDF will hold it.
 */
export function ResultPreview({
  result,
  busy,
  rendering,
  label,
  filter,
  page,
}: Props): JSX.Element {
  const canvasRef: RefObject<HTMLCanvasElement | null> =
    useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas: HTMLCanvasElement | null = canvasRef.current;
    if (!canvas || !result) return;
    if (page) drawPage(canvas, result, page);
    else drawDocument(canvas, result);
  }, [result, page]);

  return (
    <>
      {result && (
        <canvas
          ref={canvasRef}
          className={`result${page ? ' is-page' : ''}${busy ? ' is-busy' : ''}`}
          role="img"
          aria-label={label}
          data-testid="result"
          data-filter={filter}
          data-page-format={page?.pageFormat}
        />
      )}
      {rendering && <Spinner data-testid="loading" />}
    </>
  );
}
