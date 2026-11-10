import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  clickContinue,
  cornerOnScreen,
  type DownloadedFile,
  editorCorners,
  type Point,
  type Quad,
  readImage,
  readZip,
} from '@/test-support/e2e/app';
import {
  choose,
  type DecodedImage,
  decodeImage,
  exportFile,
  openAdjust,
  type PreviewPixels,
  previewPixels,
  resultSize,
  resultStatus,
  seenTransients,
  settledPixels,
  showDocument,
  type Size,
  sizeText,
  watchTransients,
} from '@/test-support/e2e/result';

/** Time for a new render of the preview, which runs OpenCV. */
const RENDER_TIMEOUT: { timeout: number } = { timeout: 30_000 };

/** The loading spinner over the preview, for `watchTransients`. */
const SPINNER: string = '[data-testid="loading"]';

/** The preview faded while a new render runs, for `watchTransients`. */
const BUSY_PREVIEW: string = '[data-testid="result"].is-busy';

/** The width and the height of a size, swapped, as a quarter turn does. */
function swapped(size: Size): Size {
  return { width: size.height, height: size.width };
}

/** The straight-line distance between two points, in their unit. */
function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The size of the crop of these corners, as the cropper computes it: the longest of the top and
 * bottom edges by the longest of the left and right edges.
 */
function cropSize([topLeft, topRight, bottomRight, bottomLeft]: Quad): Size {
  return {
    width: Math.round(
      Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight)),
    ),
    height: Math.round(
      Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight)),
    ),
  };
}

/** Checks two sizes are the same, give or take a pixel of rounding. */
function expectSizeNear(actual: Size, expected: Size): void {
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(1);
}

/** Rotates the document on display a quarter turn. */
async function rotate(
  page: Page,
  direction: 'Esquerda' | 'Direita',
): Promise<void> {
  await page.getByRole('button', { name: direction, exact: true }).click();
}

/** Clicks the button named exactly "Voltar" (Back), which returns to the previous step. */
async function clickBack(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
}

/** The top bar marks the step at this position, from 0, as the current one. */
async function expectStep(page: Page, index: number): Promise<void> {
  await expect(page.getByTestId(`step-${String(index)}`)).toHaveAttribute(
    'aria-current',
    'step',
  );
}

/** Screen pixels per photo pixel in the crop editor. */
async function editorScale(page: Page): Promise<number> {
  const scale: number = await page
    .getByTestId('corner-editor')
    .evaluate((svg: Element): number => {
      const ctm: DOMMatrix | null = (svg as SVGSVGElement).getScreenCTM();
      return ctm ? ctm.a : 0;
    });
  expect(scale).toBeGreaterThan(0);
  return scale;
}

/**
 * Drags a corner of the crop editor with the mouse by an amount in photo pixels, and returns the
 * corners the editor shows once the drag is over.
 */
async function dragCorner(
  page: Page,
  index: number,
  delta: Point,
): Promise<Quad> {
  const scale: number = await editorScale(page);
  const start: Point = await cornerOnScreen(page, index);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x * scale, start.y + delta.y * scale, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(page.getByTestId('loupe')).toHaveCount(0);
  await expect(page.getByTestId(`corner-${String(index)}`)).not.toHaveClass(
    /is-active/,
  );
  return editorCorners(page);
}

/** The image of a carousel tile, by its position from 0. */
function thumbnail(page: Page, index: number): Locator {
  return page.getByTestId(`doc-${String(index)}`).locator('img');
}

/** What the pixels of a thumbnail look like. */
interface ThumbnailPixels {
  /** The data URL of the thumbnail, to tell when it changes. */
  src: string;
  width: number;
  height: number;
  /** Largest difference between two channels of any pixel: about 0 for a gray image. */
  maxChannelSpread: number;
  /** Share of pixels whose channels differ by more than 24, so clearly colored. */
  colorfulShare: number;
}

/**
 * Reads the pixels of the thumbnail of a tile by drawing its image into a canvas, once it shows
 * the render of the document (not the original photo) and is no longer pending.
 */
async function thumbnailPixels(
  page: Page,
  index: number,
): Promise<ThumbnailPixels> {
  const tile: Locator = page.getByTestId(`doc-${String(index)}`);
  await expect(thumbnail(page, index)).toHaveClass(
    'is-preview',
    RENDER_TIMEOUT,
  );
  await expect(tile).not.toHaveAttribute('aria-busy', 'true', RENDER_TIMEOUT);
  return thumbnail(page, index).evaluate(
    async (element: HTMLElement): Promise<ThumbnailPixels> => {
      if (!(element instanceof HTMLImageElement))
        throw new Error('The thumbnail is not an image');
      await element.decode();
      const { naturalWidth: width, naturalHeight: height } = element;
      const canvas: HTMLCanvasElement = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
      if (!context) throw new Error('No 2D context');
      context.drawImage(element, 0, 0);
      const data: Uint8ClampedArray = context.getImageData(
        0,
        0,
        width,
        height,
      ).data;
      let maxChannelSpread: number = 0;
      let colorful: number = 0;
      for (let i: number = 0; i < data.length; i += 4) {
        const spread: number =
          Math.max(data[i], data[i + 1], data[i + 2]) -
          Math.min(data[i], data[i + 1], data[i + 2]);
        if (spread > maxChannelSpread) maxChannelSpread = spread;
        if (spread > 24) colorful++;
      }
      return {
        src: element.src,
        width,
        height,
        maxChannelSpread,
        colorfulShare: colorful / (width * height),
      };
    },
  );
}

/** Reads the largest channel spread of a thumbnail, for `expect.poll`. */
function thumbnailSpread(page: Page, index: number): () => Promise<number> {
  return async (): Promise<number> =>
    (await thumbnailPixels(page, index)).maxChannelSpread;
}

/** Checks a thumbnail is gray: JPEG compression leaves its channels a step apart at most. */
function expectGray(pixels: ThumbnailPixels): void {
  expect(pixels.maxChannelSpread).toBeLessThanOrEqual(2);
}

/** Checks a thumbnail keeps the colors of the photo. */
function expectColor(pixels: ThumbnailPixels): void {
  expect(pixels.maxChannelSpread).toBeGreaterThan(40);
  expect(pixels.colorfulShare).toBeGreaterThan(0.005);
}

/**
 * Checks a thumbnail is another one turned a quarter: it fits the same box, so its sides are not
 * the swapped ones, but its aspect ratio is the inverse.
 */
function expectQuarterTurn(
  turned: ThumbnailPixels,
  upright: ThumbnailPixels,
): void {
  expect(turned.width).toBeGreaterThan(turned.height);
  expect(turned.width / turned.height).toBeCloseTo(
    upright.height / upright.width,
    1,
  );
}

test.describe('Renders after changes', (): void => {
  test('renders the new crop with the same adjustments after going back to Crop', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    const original: Size = await resultSize(page);

    await choose(page, 'Preto e branco');
    await rotate(page, 'Direita');
    await expect(resultStatus(page)).toHaveText(
      sizeText(swapped(original)),
      RENDER_TIMEOUT,
    );

    // Back in Crop, the corners of the first render, then both ends dragged far inward
    await clickBack(page);
    await expectStep(page, 1);
    const before: Quad = await editorCorners(page);
    expectSizeNear(cropSize(before), original);
    await dragCorner(page, 0, { x: 180, y: 220 });
    const after: Quad = await dragCorner(page, 2, { x: -200, y: -220 });
    const cropped: Size = cropSize(after);
    expect(cropped.width).toBeLessThan(original.width * 0.85);
    expect(cropped.height).toBeLessThan(original.height * 0.85);

    await clickContinue(page);
    await expectStep(page, 2);

    // The same adjustments, on the new crop: still black and white, still a quarter turn
    await expect(
      page.getByRole('radio', { name: 'Preto e branco', exact: true }),
    ).toBeChecked();
    await expect(page.getByTestId('result')).toHaveAttribute(
      'data-filter',
      'bw',
    );
    const size: Size = await resultSize(page);
    expectSizeNear(size, swapped(cropped));
    const shown: PreviewPixels = await settledPixels(page);
    expect({ width: shown.width, height: shown.height }).toEqual(size);
    expect(shown.maxChannelSpread).toBe(0);
    expect(shown.midtoneShare).toBeLessThan(0.001);
    // Still a page with text, not a blank render
    expect(shown.edgeEnergy).toBeGreaterThan(1);

    // The export is that very render
    await page.getByTestId('continue').click();
    await expectStep(page, 3);
    await expect(page.getByTestId('download')).toBeEnabled();
    await expect(resultStatus(page)).toHaveText(sizeText(size));
    await choose(page, 'PNG');
    const file: DownloadedFile = await exportFile(page);
    expect(readImage(file.data)).toEqual({ format: 'png', ...size });
    const decoded: DecodedImage = await decodeImage(page, file.data);
    expect(decoded).toEqual({
      ...size,
      maxChannelSpread: 0,
      checksum: shown.checksum,
    });
  });

  test('thumbnails follow the adjustments of their document, in Adjust and in Export', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg']);
    const invoice: ThumbnailPixels = await thumbnailPixels(page, 0);
    const receipt: ThumbnailPixels = await thumbnailPixels(page, 1);
    expectColor(invoice);
    expectColor(receipt);
    // The invoice is a portrait sheet
    expect(invoice.width).toBeLessThan(invoice.height);

    // Grayscale and a quarter turn on the invoice only
    await choose(page, 'Cinza');
    await rotate(page, 'Direita');
    await expect
      .poll(thumbnailSpread(page, 0), RENDER_TIMEOUT)
      .toBeLessThanOrEqual(2);
    const grayInvoice: ThumbnailPixels = await thumbnailPixels(page, 0);
    expectGray(grayInvoice);
    expectQuarterTurn(grayInvoice, invoice);
    // The receipt is untouched
    const stillReceipt: ThumbnailPixels = await thumbnailPixels(page, 1);
    expectColor(stillReceipt);
    expect(stillReceipt.src).toBe(receipt.src);

    // Copied to the receipt, which is not on display: its thumbnail turns gray, not rotated
    await page.getByTestId('apply-all').click();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'ajustes' }),
    ).toHaveText('Os ajustes foram aplicados aos 2 documentos.');
    await expect
      .poll(thumbnailSpread(page, 1), RENDER_TIMEOUT)
      .toBeLessThanOrEqual(2);
    const grayReceipt: ThumbnailPixels = await thumbnailPixels(page, 1);
    expectGray(grayReceipt);
    expect({ width: grayReceipt.width, height: grayReceipt.height }).toEqual({
      width: receipt.width,
      height: receipt.height,
    });
    await expect(page.getByTestId('doc-0')).toHaveAttribute(
      'aria-current',
      'true',
    );

    // The Export step shows the same adjusted thumbnails
    await page.getByTestId('continue').click();
    await expectStep(page, 3);
    const exportInvoice: ThumbnailPixels = await thumbnailPixels(page, 0);
    const exportReceipt: ThumbnailPixels = await thumbnailPixels(page, 1);
    expectGray(exportInvoice);
    expectGray(exportReceipt);
    expectQuarterTurn(exportInvoice, invoice);
    expect(exportReceipt.width).toBe(receipt.width);
    expect(exportReceipt.height).toBe(receipt.height);

    // And the export of the receipt is gray too
    await choose(page, 'PNG');
    const file: DownloadedFile = await exportFile(page);
    const zip: Map<string, Uint8Array> = readZip(file.data);
    expect([...zip.keys()]).toEqual(['1-invoice.png', '2-receipt.png']);
    for (const name of ['1-invoice.png', '2-receipt.png']) {
      const decoded: DecodedImage = await decodeImage(
        page,
        zip.get(name) ?? new Uint8Array(),
      );
      expect(decoded.maxChannelSpread, name).toBe(0);
    }
  });

  test('shows renders made before without a loading state, across documents and steps', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg']);
    // Both documents rendered once, with their current adjustments
    const invoice: PreviewPixels = await settledPixels(page);
    await showDocument(page, 1);
    const receipt: PreviewPixels = await settledPixels(page);
    await showDocument(page, 0);
    await expect
      .poll(async (): Promise<number> => (await previewPixels(page)).checksum)
      .toBe(invoice.checksum);

    await watchTransients(page, [SPINNER, BUSY_PREVIEW]);

    // Adjust → Export, then the other document, then back. Exporting to PNG, the Export step
    // shows the render itself, not on a PDF page
    await page.getByTestId('continue').click();
    await expectStep(page, 3);
    await choose(page, 'PNG');
    expect((await settledPixels(page)).checksum).toBe(invoice.checksum);
    await showDocument(page, 1);
    await expect
      .poll(async (): Promise<number> => (await settledPixels(page)).checksum)
      .toBe(receipt.checksum);
    await page.getByTestId('step-2').click();
    await expectStep(page, 2);
    expect((await settledPixels(page)).checksum).toBe(receipt.checksum);
    await showDocument(page, 0);
    await expect
      .poll(async (): Promise<number> => (await settledPixels(page)).checksum)
      .toBe(invoice.checksum);
    await page.getByTestId('continue').click();
    await expectStep(page, 3);
    await clickBack(page);
    await expectStep(page, 2);
    expect((await settledPixels(page)).checksum).toBe(invoice.checksum);

    // Adjust → Crop → Adjust, the crop untouched
    await clickBack(page);
    await expectStep(page, 1);
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await clickContinue(page);
    await expectStep(page, 2);
    expect((await settledPixels(page)).checksum).toBe(invoice.checksum);

    // No spinner and no faded preview at any moment
    expect((await seenTransients(page)).selectors).toEqual([]);

    // A new adjustment is a new render: it shows the loading state
    await choose(page, 'Cinza');
    await expect
      .poll(
        async (): Promise<number> =>
          (await previewPixels(page)).maxChannelSpread,
        RENDER_TIMEOUT,
      )
      .toBe(0);
    await resultSize(page);
    expect((await seenTransients(page)).selectors).toEqual(
      expect.arrayContaining([SPINNER, BUSY_PREVIEW]),
    );
  });

  test('keeps the size in the status when it shows a render made before', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Known bug: showing a cached render of another document flashes
    // "Documento 2 de 2 · Aplicando…" in the status, for as long as the cached PNG takes to
    // decode, with the canvas still showing the previous document. Nothing is applied: the render
    // is already done
    test.fail();
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg']);
    const invoice: Size = await resultSize(page);
    await showDocument(page, 1);
    const receipt: Size = await resultSize(page);
    await showDocument(page, 0);
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 2 · ${sizeText(invoice)}`,
    );

    await watchTransients(page, [SPINNER, BUSY_PREVIEW]);
    await showDocument(page, 1);
    await expect(resultStatus(page)).toHaveText(
      `Documento 2 de 2 · ${sizeText(receipt)}`,
    );
    await showDocument(page, 0);
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 2 · ${sizeText(invoice)}`,
    );

    // Straight from one size to the other, with no "Aplicando…" in between
    expect((await seenTransients(page)).statuses).toEqual([
      `Documento 1 de 2 · ${sizeText(invoice)}`,
      `Documento 2 de 2 · ${sizeText(receipt)}`,
      `Documento 1 de 2 · ${sizeText(invoice)}`,
    ]);
  });
});
