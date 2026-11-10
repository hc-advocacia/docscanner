import { readFile } from 'node:fs/promises';

import {
  type Canvas,
  createCanvas,
  type Image,
  loadImage,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  clickContinue,
  documentTiles,
  type DownloadedFile,
  editorCorners,
  FIXTURE_CORNERS,
  fixturePath,
  type ImageInfo,
  maxCornerError,
  openApp,
  type Point,
  type Quad,
  readImage,
} from '@/test-support/e2e/app';
import {
  choose,
  exportFile,
  resultSize,
  type Size,
} from '@/test-support/e2e/result';

/** Largest distance, in pixels of the photo, between a detected corner and the real one. */
const DETECTION_TOLERANCE: number = 10;

/** The longest side the document works on: larger photos are shrunk to it before processing. */
const MAX_DIMENSION: number = 3000;

/** How much the large photo is scaled up from invoice.jpg (1600 × 1200 to 4800 × 3600). */
const LARGE_FACTOR: number = 3;

/**
 * The cropped invoice sheet of invoice.jpg, as the other specs measure it: about 810 × 890 px,
 * almost square and a bit taller than wide.
 */
const INVOICE_DOCUMENT: Size = { width: 810, height: 890 };

/** A file built by the test, to upload through the file picker. */
interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Where the dark red pixels of a decoded document are: the logo of the invoice is dark red. */
interface RedPixels {
  /** How many pixels are dark red, in the whole image. */
  total: number;
  /** How many of them are in the top left quarter of the image. */
  topLeft: number;
}

/** Decodes invoice.jpg with the canvas of Node, to draw new photos from it. */
async function loadInvoice(): Promise<Image> {
  return loadImage(await readFile(fixturePath('invoice.jpg')));
}

/** A new blank canvas of Node, of this size in pixels, with its 2D context. */
function canvasOf(
  width: number,
  height: number,
): { canvas: Canvas; context: SKRSContext2D } {
  const canvas: Canvas = createCanvas(width, height);
  return { canvas, context: canvas.getContext('2d') };
}

/** invoice.jpg scaled up three times, to 4800 × 3600 px: past the processing limit. */
async function largeInvoice(): Promise<UploadFile> {
  const invoice: Image = await loadInvoice();
  const { canvas, context } = canvasOf(
    invoice.width * LARGE_FACTOR,
    invoice.height * LARGE_FACTOR,
  );
  context.drawImage(invoice, 0, 0, canvas.width, canvas.height);
  return {
    name: 'invoice-large.jpg',
    mimeType: 'image/jpeg',
    buffer: canvas.toBuffer('image/jpeg', 90),
  };
}

/** invoice.jpg converted to WebP, at the same size. */
async function webpInvoice(): Promise<UploadFile> {
  const invoice: Image = await loadInvoice();
  const { canvas, context } = canvasOf(invoice.width, invoice.height);
  context.drawImage(invoice, 0, 0);
  return {
    name: 'invoice.webp',
    mimeType: 'image/webp',
    buffer: canvas.toBuffer('image/webp', 90),
  };
}

/**
 * An APP1 segment with an Exif block that holds only the Orientation tag (0x0112), big-endian.
 *
 * @param orientation 6: show the pixels turned a quarter clockwise; 8: counterclockwise.
 */
function exifOrientationSegment(orientation: 6 | 8): Buffer {
  const tiff: Buffer = Buffer.from([
    // Byte order (Motorola), magic number 42, offset of the first IFD
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    // One entry: Orientation, SHORT, count 1, value in the first two bytes
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    // No next IFD
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const payload: Buffer = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
  ]);
  const header: Buffer = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  // The length counts itself, not the marker
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A phone photo of invoice.jpg: its pixels stored a quarter turn away from upright (1200 × 1600)
 * and an EXIF Orientation tag that turns them back, so a viewer that reads the tag shows
 * invoice.jpg as it is.
 */
async function rotatedInvoice(orientation: 6 | 8): Promise<UploadFile> {
  const invoice: Image = await loadInvoice();
  const { canvas, context } = canvasOf(invoice.height, invoice.width);
  if (orientation === 6) {
    // Stored a quarter turn counterclockwise: the viewer turns it clockwise
    context.translate(0, invoice.width);
    context.rotate(-Math.PI / 2);
  } else {
    // Stored a quarter turn clockwise: the viewer turns it counterclockwise
    context.translate(invoice.height, 0);
    context.rotate(Math.PI / 2);
  }
  context.drawImage(invoice, 0, 0);
  const jpeg: Buffer = canvas.toBuffer('image/jpeg', 92);
  return {
    name: `invoice-exif-${String(orientation)}.jpg`,
    mimeType: 'image/jpeg',
    // Right after the start-of-image marker, where cameras write it
    buffer: Buffer.concat([
      jpeg.subarray(0, 2),
      exifOrientationSegment(orientation),
      jpeg.subarray(2),
    ]),
  };
}

/** The opaque white sheet of the transparent PNG, in its pixels. */
const SHEET: { x: number; y: number; size: number } = {
  x: 200,
  y: 100,
  size: 400,
};

/**
 * Areas of the sheet that are not opaque, as fractions of the sheet: a fully transparent hole
 * and a white patch at 40% opacity. Both must look white on paper.
 */
const HOLE: Point = { x: 0.275, y: 0.65 };
const TRANSLUCENT_PATCH: Point = { x: 0.725, y: 0.65 };

/** A part of the sheet that is opaque white, to check the samples are where they should be. */
const OPAQUE_WHITE: Point = { x: 0.5, y: 0.4 };

/**
 * An 800 × 600 PNG with a fully transparent background and an opaque white sheet with a dark
 * title bar, a transparent hole and a translucent white patch, as an image cut out by an editor.
 */
function transparentDocument(): UploadFile {
  const { canvas, context } = canvasOf(800, 600);
  const { x, y, size } = SHEET;
  context.fillStyle = '#ffffff';
  context.fillRect(x, y, size, size);
  context.fillStyle = '#222222';
  context.fillRect(x + 50, y + 50, 300, 20);
  // 120 px squares centered on HOLE and TRANSLUCENT_PATCH
  context.clearRect(x + 50, y + 200, 120, 120);
  context.clearRect(x + 230, y + 200, 120, 120);
  context.fillStyle = 'rgba(255, 255, 255, 0.4)';
  context.fillRect(x + 230, y + 200, 120, 120);
  return {
    name: 'cutout.png',
    mimeType: 'image/png',
    buffer: canvas.toBuffer('image/png'),
  };
}

/**
 * Uploads a file through the file picker of the empty Upload step and waits until it is imported,
 * with no toast.
 */
async function uploadFile(page: Page, file: UploadFile): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('upload-files').click(),
  ]);
  await chooser.setFiles(file);
  await expect(documentTiles(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('import-progress')).toBeHidden({
    timeout: 60_000,
  });
  await expect(page.getByTestId('toast')).toHaveCount(0);
}

/** Opens the app, uploads the file and goes to the Crop step. */
async function openCropWith(page: Page, file: UploadFile): Promise<void> {
  await openApp(page);
  await uploadFile(page, file);
  await page.getByTestId('upload-continue').click();
  await expect(page.getByTestId('corner-editor')).toBeVisible();
}

/** From the Crop step, goes to the Export step and waits for the preview. Returns its size. */
async function goToExport(page: Page): Promise<Size> {
  await clickContinue(page);
  await expect(page.getByTestId('step-2')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await resultSize(page);
  await page.getByTestId('continue').click();
  await expect(page.getByTestId('step-3')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByTestId('download')).toBeEnabled();
  return resultSize(page);
}

/** The corners scaled by `factor` from the top left of the photo, as the photo is scaled. */
function scaleQuad(quad: Quad, factor: number): Quad {
  return quad.map((point: Point): Point => ({
    x: point.x * factor,
    y: point.y * factor,
  })) as Quad;
}

/**
 * Checks an exported image is the invoice sheet, upright: a bit taller than wide, and the size of
 * {@link INVOICE_DOCUMENT} times `scale`, within 5%.
 */
function expectUprightInvoiceShape(image: ImageInfo, scale: number): void {
  const aspect: number = image.width / image.height;
  expect(aspect, 'portrait-ish, as the invoice sheet').toBeGreaterThan(0.85);
  expect(aspect, 'portrait-ish, as the invoice sheet').toBeLessThan(1);
  expect(image.width).toBeGreaterThan(INVOICE_DOCUMENT.width * scale * 0.95);
  expect(image.width).toBeLessThan(INVOICE_DOCUMENT.width * scale * 1.05);
  expect(image.height).toBeGreaterThan(INVOICE_DOCUMENT.height * scale * 0.95);
  expect(image.height).toBeLessThan(INVOICE_DOCUMENT.height * scale * 1.05);
}

/** Decodes an image in the page and reads the colors at points given as fractions of its size. */
async function pixelsAt(
  page: Page,
  data: Uint8Array,
  points: Point[],
): Promise<Rgb[]> {
  return page.evaluate(
    async ({
      base64,
      fractions,
    }: {
      base64: string;
      fractions: Point[];
    }): Promise<Rgb[]> => {
      const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(
        atob(base64),
        (char: string): number => char.charCodeAt(0),
      );
      const bitmap: ImageBitmap = await createImageBitmap(new Blob([bytes]));
      const canvas: OffscreenCanvas = new OffscreenCanvas(
        bitmap.width,
        bitmap.height,
      );
      const context: OffscreenCanvasRenderingContext2D | null =
        canvas.getContext('2d');
      if (!context) throw new Error('No 2D context');
      context.drawImage(bitmap, 0, 0);
      return fractions.map((point: Point): Rgb => {
        const [r, g, b] = context.getImageData(
          Math.floor(point.x * bitmap.width),
          Math.floor(point.y * bitmap.height),
          1,
          1,
        ).data;
        return { r, g, b };
      });
    },
    { base64: Buffer.from(data).toString('base64'), fractions: points },
  );
}

/**
 * Decodes an image in the page and counts its dark red pixels, in all and in the top left quarter.
 */
async function redPixels(page: Page, data: Uint8Array): Promise<RedPixels> {
  return page.evaluate(async (base64: string): Promise<RedPixels> => {
    const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(
      atob(base64),
      (char: string): number => char.charCodeAt(0),
    );
    const bitmap: ImageBitmap = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bitmap;
    const canvas: OffscreenCanvas = new OffscreenCanvas(width, height);
    const context: OffscreenCanvasRenderingContext2D | null =
      canvas.getContext('2d');
    if (!context) throw new Error('No 2D context');
    context.drawImage(bitmap, 0, 0);
    const pixels: Uint8ClampedArray = context.getImageData(
      0,
      0,
      width,
      height,
    ).data;
    const counts: RedPixels = { total: 0, topLeft: 0 };
    for (let y: number = 0; y < height; y++) {
      for (let x: number = 0; x < width; x++) {
        const i: number = (y * width + x) * 4;
        const r: number = pixels[i];
        const g: number = pixels[i + 1];
        const b: number = pixels[i + 2];
        if (r > 100 && g < 60 && b < 80 && r - g > 60) {
          counts.total++;
          if (x < width / 2 && y < height / 2) counts.topLeft++;
        }
      }
    }
    return counts;
  }, Buffer.from(data).toString('base64'));
}

/** The darkest channel of a pixel: white is near 255 in every channel. */
function lightness(pixel: Rgb): number {
  return Math.min(pixel.r, pixel.g, pixel.b);
}

/** Checks the detected corners of the transparent PNG are on its opaque sheet. */
async function expectCornersOnSheet(page: Page): Promise<void> {
  const { x, y, size } = SHEET;
  expect(
    maxCornerError(await editorCorners(page), [
      { x, y },
      { x: x + size, y },
      { x: x + size, y: y + size },
      { x, y: y + size },
    ]),
  ).toBeLessThan(DETECTION_TOLERANCE);
}

test.describe('Image inputs', (): void => {
  test('a photo larger than 3000 px is cropped in its own pixels and exported at the processing limit', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCropWith(page, await largeInvoice());

    // The editor shows the photo as uploaded, and the corners are in its pixels
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 4800 3600',
    );
    expect(
      maxCornerError(
        await editorCorners(page),
        scaleQuad(FIXTURE_CORNERS['invoice.jpg'], LARGE_FACTOR),
      ),
      'within 1% of the photo width',
    ).toBeLessThan(4800 * 0.01);

    const size: Size = await goToExport(page);
    await choose(page, 'PNG');
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice-large.png');
    const image: ImageInfo = readImage(file.data);
    expect(image).toEqual({ format: 'png', ...size });
    // The document is processed with the photo shrunk to 3000 px (4800 × 3600 to 3000 × 2250):
    // the sheet is 1.875 times the one of invoice.jpg, not 3 times
    expect(Math.max(image.width, image.height)).toBeLessThan(MAX_DIMENSION);
    expectUprightInvoiceShape(image, MAX_DIMENSION / 1600);
  });

  test('a WebP photo is imported and its document detected', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadFile(page, await webpInvoice());

    // The Upload step shows the original photo
    await expect
      .poll(async (): Promise<string> =>
        page
          .getByTestId('doc-0')
          .locator('img')
          .evaluate((img: HTMLElement): string =>
            img instanceof HTMLImageElement && img.complete
              ? `${String(img.naturalWidth)}x${String(img.naturalHeight)}`
              : '',
          ),
      )
      .toBe('1600x1200');

    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 1600 1200',
    );
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);
    await expect(page.getByTestId('detect-status')).toHaveText(
      'Mova os cantos para enquadrar a área da imagem que deseja escanear',
    );
    await expect(page.getByTestId('crop')).toBeEnabled();

    const size: Size = await goToExport(page);
    await choose(page, 'PNG');
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.png');
    const image: ImageInfo = readImage(file.data);
    expect(image).toEqual({ format: 'png', ...size });
    expectUprightInvoiceShape(image, 1);
  });

  for (const orientation of [6, 8] as const) {
    test(`a phone photo with EXIF orientation ${String(orientation)} is shown, cropped and exported upright`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      const file: UploadFile = await rotatedInvoice(orientation);
      // The pixels of the file are stored sideways
      expect(readImage(file.buffer)).toEqual({
        format: 'jpeg',
        width: 1200,
        height: 1600,
      });

      await openCropWith(page, file);

      // The editor shows the photo upright, as invoice.jpg, with the corners on its sheet
      await expect(page.getByTestId('corner-editor')).toHaveAttribute(
        'viewBox',
        '0 0 1600 1200',
      );
      expect(
        maxCornerError(
          await editorCorners(page),
          FIXTURE_CORNERS['invoice.jpg'],
        ),
      ).toBeLessThan(DETECTION_TOLERANCE);
      await expect(page.getByTestId('crop')).toBeEnabled();

      const size: Size = await goToExport(page);
      await choose(page, 'PNG');
      const exported: DownloadedFile = await exportFile(page);

      const image: ImageInfo = readImage(exported.data);
      expect(image).toEqual({ format: 'png', ...size });
      expectUprightInvoiceShape(image, 1);
      // The dark red logo of the invoice is at the top left of the sheet: on a sideways or upside
      // down export it would be in another corner
      const red: RedPixels = await redPixels(page, exported.data);
      expect(red.total).toBeGreaterThan(1000);
      expect(red.topLeft / red.total).toBeGreaterThan(0.9);
    });
  }

  test('a transparent PNG exported as JPG keeps its transparent areas white, not black', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Known bug: the transparent hole of the sheet comes out black (0, 0, 0) and the 40% white
    // patch dark gray (about 102): JpegImageEncoder encodes the render, which keeps the alpha of
    // the PNG, with canvas.toDataURL('image/jpeg') and no white fill below it
    test.fail();
    await openCropWith(page, transparentDocument());
    await expectCornersOnSheet(page);

    const size: Size = await goToExport(page);
    await choose(page, 'JPG');
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('cutout.jpg');
    expect(readImage(file.data)).toEqual({ format: 'jpeg', ...size });
    const [white, hole, patch] = await pixelsAt(page, file.data, [
      OPAQUE_WHITE,
      HOLE,
      TRANSLUCENT_PATCH,
    ]);
    expect(lightness(white), 'the opaque sheet is white').toBeGreaterThan(230);
    expect(lightness(hole), 'the transparent hole is white').toBeGreaterThan(
      200,
    );
    expect(
      lightness(patch),
      'the translucent white patch is white',
    ).toBeGreaterThan(200);
  });

  test('the thumbnail of a transparent PNG keeps its transparent areas white, not black', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Known bug: the thumbnail shows the transparent hole black (0, 0, 0) and the 40% white
    // patch dark gray: thumbnailFrom (apps/web/src/lib/image.ts) encodes it with
    // canvas.toDataURL('image/jpeg') and no white fill below it
    test.fail();
    await openCropWith(page, transparentDocument());
    await expectCornersOnSheet(page);

    // The Crop step shows the cropped document in the tile, once its thumbnail is ready
    const tile: Locator = page.getByTestId('doc-0');
    const thumbnail: Locator = tile.locator('img');
    await expect(thumbnail).toHaveClass('is-preview');
    await expect(tile).not.toHaveAttribute('aria-busy', 'true');
    const src: string = (await thumbnail.getAttribute('src')) ?? '';
    expect(src).toMatch(/^data:image\/jpeg;base64,/);
    const jpeg: Buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    // The sheet is square: 403 × 403 px scaled down to the 112 px of the thumbnail
    expect(readImage(jpeg)).toEqual({
      format: 'jpeg',
      width: 112,
      height: 112,
    });

    const [white, hole, patch] = await pixelsAt(page, jpeg, [
      OPAQUE_WHITE,
      HOLE,
      TRANSLUCENT_PATCH,
    ]);
    expect(lightness(white), 'the opaque sheet is white').toBeGreaterThan(230);
    expect(lightness(hole), 'the transparent hole is white').toBeGreaterThan(
      200,
    );
    expect(
      lightness(patch),
      'the translucent white patch is white',
    ).toBeGreaterThan(200);
  });
});
