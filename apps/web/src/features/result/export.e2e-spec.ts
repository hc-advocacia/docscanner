import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  clickContinue,
  documentTiles,
  type DownloadedFile,
  type ImageInfo,
  type PdfInfo,
  readImage,
  readPdf,
  readZip,
  uploadImages,
} from '@/test-support/e2e/app';
import {
  A4,
  choose,
  type DecodedImage,
  decodeImage,
  expectedPlacement,
  expectPlacement,
  exportFile,
  fileStamp,
  LETTER,
  openExport,
  PDF_IMAGE_DPI,
  pdfImagePlacements,
  pdfImageSizes,
  pdfPageOperators,
  type PixelRegion,
  POINTS_PER_CM,
  previewCanvasSize,
  type PreviewPixels,
  previewRegion,
  type RegionPixels,
  resultSize,
  resultStatus,
  seenTransients,
  settledPixels,
  showDocument,
  type Size,
  sizeText,
  type Transients,
  uploadAs,
  watchTransients,
} from '@/test-support/e2e/result';

const PNG_SIGNATURE: number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** The toast that confirms a file was downloaded. */
function savedToast(page: Page): Locator {
  return page.getByTestId('toast').filter({ hasText: 'Arquivo baixado' });
}

/** Picks the page of the PDF: A4, Letter, or the size of the document (`image`). */
async function choosePage(
  page: Page,
  format: 'a4' | 'letter' | 'image',
): Promise<void> {
  await page.getByLabel('Formato da página').selectOption(format);
}

/** Fills the masked margins field, in centimeters, with the 2 decimal places it shows. */
async function setMargins(page: Page, centimeters: number): Promise<void> {
  await page.getByTestId('margins').fill(centimeters.toFixed(2));
  await expect(page.getByTestId('margins')).toHaveValue(centimeters.toFixed(2));
}

/** A "Document size" page: the image at 150 dpi, plus the margins on each side. */
function documentSizePage(size: Size, margins: number = 0): Size {
  return {
    width: (size.width * 72) / PDF_IMAGE_DPI + margins * 2,
    height: (size.height * 72) / PDF_IMAGE_DPI + margins * 2,
  };
}

/** Checks a PDF page size, to about a twentieth of a point. */
function expectPageSize(actual: Size, expected: Size): void {
  expect(actual.width).toBeCloseTo(expected.width, 1);
  expect(actual.height).toBeCloseTo(expected.height, 1);
}

/** The preview of the Export step. */
function preview(page: Page): Locator {
  return page.getByTestId('result');
}

/**
 * Checks the preview shows a PDF page of this size, in points: its proportions, to a pixel, and as
 * large as the render along the longest side.
 */
async function expectPagePreview(
  page: Page,
  pageSize: Size,
  render: Size,
): Promise<void> {
  const longest: number = Math.max(render.width, render.height);
  const scale: number = longest / Math.max(pageSize.width, pageSize.height);
  await expect
    .poll(async (): Promise<Size> => previewCanvasSize(page))
    .toEqual({
      width: Math.round(pageSize.width * scale),
      height: Math.round(pageSize.height * scale),
    });
}

/** Checks the preview shows the render on its own, at its size, as in the Adjust step. */
async function expectPlainPreview(page: Page, render: Size): Promise<void> {
  await expect(preview(page)).not.toHaveAttribute('data-page-format');
  await expect(preview(page)).toHaveAccessibleName(
    'Prévia do documento 1, recortado',
  );
  await expect
    .poll(async (): Promise<Size> => previewCanvasSize(page))
    .toEqual(render);
}

/** The result size of every document, in carousel order, read from the status. */
async function documentSizes(page: Page): Promise<Size[]> {
  const sizes: Size[] = [];
  const count: number = await documentTiles(page).count();
  for (let index: number = 0; index < count; index++) {
    await showDocument(page, index);
    sizes.push(await resultSize(page));
  }
  return sizes;
}

/**
 * Checks a batch file name: `documentos-<UTC date and time>.<extension>`, with a stamp between the
 * `before` and `after` ones taken around the export.
 */
function expectBatchName(
  name: string,
  extension: string,
  before: string,
  after: string,
): void {
  const match: RegExpExecArray | null = new RegExp(
    `^documentos-(\\d{12})\\.${extension}$`,
  ).exec(name);
  expect(match, name).not.toBeNull();
  const stamp: string = match?.[1] ?? '';
  expect(stamp >= before && stamp <= after, stamp).toBe(true);
}

test.describe('Export step', (): void => {
  test('exports one document as an A4 PDF named after the photo, and says so', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);
    await expect(
      page.getByRole('radio', { name: 'PDF', exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel('Formato da página')).toHaveValue('a4');
    await expect(page.getByTestId('margins')).toHaveValue('0.00');

    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.pdf');
    expect(file.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageCount).toBe(1);
    // The invoice is taller than wide: a portrait page
    expectPageSize(pdf.pageSizes[0], A4);
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(placement, expectedPlacement(size, A4, 0));
    // The render at full resolution, not scaled down to fit the page
    expect(await pdfImageSizes(file.data)).toEqual([size]);

    await expect(savedToast(page)).toHaveText('Arquivo baixado: invoice.pdf');
    await expect(savedToast(page)).toHaveAttribute('data-kind', 'success');
    // The button comes back once the progress bar is done
    await expect(page.getByTestId('download')).toBeEnabled();
  });

  test('previews the PDF page of the options, and the plain render for PNG and in Adjust', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    // The portrait invoice on a portrait A4 page, the default
    await expect(preview(page)).toHaveAttribute('data-page-format', 'a4');
    await expect(preview(page)).toHaveAccessibleName(
      'Prévia do documento 1 em PDF (A4)',
    );
    await expectPagePreview(page, A4, size);
    // The status keeps the size of the render, which the PDF embeds
    await expect(resultStatus(page)).toHaveText(sizeText(size));

    await choosePage(page, 'letter');
    await expect(preview(page)).toHaveAttribute('data-page-format', 'letter');
    await expect(preview(page)).toHaveAccessibleName(
      'Prévia do documento 1 em PDF (Carta)',
    );
    await expectPagePreview(page, LETTER, size);

    await choosePage(page, 'image');
    await expectPagePreview(page, documentSizePage(size), size);
    await setMargins(page, 1.25);
    await expectPagePreview(
      page,
      documentSizePage(size, 1.25 * POINTS_PER_CM),
      size,
    );
    await expect(preview(page)).toHaveAccessibleName(
      'Prévia do documento 1 em PDF (Tamanho do documento)',
    );

    // PNG and JPG files are the render itself
    await choose(page, 'PNG');
    await expectPlainPreview(page, size);
    await choose(page, 'JPG');
    await expectPlainPreview(page, size);

    // Back to PDF, with the page options kept
    await choose(page, 'PDF');
    await expect(preview(page)).toHaveAttribute('data-page-format', 'image');
    await expectPagePreview(
      page,
      documentSizePage(size, 1.25 * POINTS_PER_CM),
      size,
    );

    // The Adjust step always shows the render
    await page.getByTestId('step-2').click();
    await expect(page.getByTestId('step-2')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expectPlainPreview(page, size);
  });

  test('previews the margins of the PDF page as white around the document, with a guide that is not exported', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await setMargins(page, 2);
    await expectPagePreview(page, A4, size);
    const canvas: Size = await previewCanvasSize(page);
    const pixelsPerPoint: number = canvas.height / A4.height;
    const margin: number = 2 * POINTS_PER_CM * pixelsPerPoint;
    // The document, centered as the PDF places it (the same from the top as from the bottom)
    const placement: PixelRegion = expectedPlacement(
      size,
      A4,
      2 * POINTS_PER_CM,
    );
    const documentArea: PixelRegion = {
      x: placement.x * pixelsPerPoint,
      y: placement.y * pixelsPerPoint,
      width: placement.width * pixelsPerPoint,
      height: placement.height * pixelsPerPoint,
    };

    // From the edges of the page to near the margin, nothing but white
    const band: number = Math.floor(margin * 0.8);
    const edges: PixelRegion[] = [
      { x: 0, y: 0, width: canvas.width, height: band },
      { x: 0, y: canvas.height - band, width: canvas.width, height: band },
      { x: 0, y: 0, width: band, height: canvas.height },
      { x: canvas.width - band, y: 0, width: band, height: canvas.height },
    ];
    for (const edge of edges) {
      expect((await previewRegion(page, edge)).whiteShare).toBe(1);
    }
    // At the margin, a light dashed guide, so the margins show even on a white document
    const guide: RegionPixels = await previewRegion(page, {
      x: margin,
      y: band,
      width: canvas.width - margin * 2,
      height: Math.floor(margin) - band,
    });
    expect(guide.lightGrayShare).toBeGreaterThan(0.02);
    expect(guide.darkShare).toBe(0);
    // Inside, the invoice with its text
    const content: RegionPixels = await previewRegion(page, {
      x: documentArea.x + 2,
      y: documentArea.y + 2,
      width: documentArea.width - 4,
      height: documentArea.height - 4,
    });
    expect(content.darkShare).toBeGreaterThan(0.005);

    // The PDF has the same page, with only the document drawn on it
    const file: DownloadedFile = await exportFile(page);
    const pdf: PdfInfo = await readPdf(file.data);
    expectPageSize(pdf.pageSizes[0], A4);
    const [exported] = await pdfImagePlacements(file.data);
    expectPlacement(exported, placement);
    // Placing and drawing the image: no lines nor shapes
    const [operators] = await pdfPageOperators(file.data);
    expect(new Set(operators)).toEqual(new Set(['q', 'cm', 'Do', 'Q']));
  });

  test('shows the progress while the file is created', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const progress: string = '[data-testid="export-progress"]';
    const labelled: string = `${progress} [role="progressbar"][aria-label="Gerando arquivo…"]`;
    const full: string = `${progress} [role="progressbar"][aria-valuenow="100"]`;
    const buttonDuringProgress: string = `body:has(${progress}) [data-testid="download"]`;

    // The page is busy encoding: the progress is noted as it happens
    await watchTransients(page, [
      progress,
      labelled,
      full,
      buttonDuringProgress,
    ]);
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.pdf');
    await expect(savedToast(page)).toHaveText('Arquivo baixado: invoice.pdf');
    // The button comes back once the bar is done
    await expect(page.locator(progress)).toHaveCount(0);
    await expect(page.getByTestId('download')).toBeEnabled();
    // A progress bar named after the task took the place of the button, and ended full
    const seen: Transients = await seenTransients(page);
    expect(seen.selectors).toEqual([progress, labelled, full]);
  });

  test('exports Letter pages', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choosePage(page, 'letter');
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.pdf');
    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageCount).toBe(1);
    expect(pdf.pageSizes[0]).toEqual(LETTER);
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(placement, expectedPlacement(size, LETTER, 0));
  });

  test('exports pages the size of the document, filled by the image', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choosePage(page, 'image');
    const file: DownloadedFile = await exportFile(page);

    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageCount).toBe(1);
    const pageSize: Size = documentSizePage(size);
    expectPageSize(pdf.pageSizes[0], pageSize);
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(placement, { x: 0, y: 0, ...pageSize });
  });

  test('turns a landscape document into a landscape A4 page', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    // Back to Adjust to turn the portrait invoice sideways
    await page.getByTestId('step-2').click();
    await page.getByRole('button', { name: 'Direita', exact: true }).click();
    const landscape: Size = { width: size.height, height: size.width };
    await expect(resultStatus(page)).toHaveText(sizeText(landscape), {
      timeout: 30_000,
    });
    await page.getByTestId('continue').click();
    await expect(resultStatus(page)).toHaveText(sizeText(landscape));

    const file: DownloadedFile = await exportFile(page);

    const pdf: PdfInfo = await readPdf(file.data);
    expectPageSize(pdf.pageSizes[0], { width: A4.height, height: A4.width });
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(
      placement,
      expectedPlacement(landscape, { width: A4.height, height: A4.width }, 0),
    );
  });

  test('applies the margins in centimeters around the image of an A4 page', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);
    const noMargins: DownloadedFile = await exportFile(page);

    await setMargins(page, 2);
    const withMargins: DownloadedFile = await exportFile(page);

    expect(withMargins.data.equals(noMargins.data)).toBe(false);
    const pdf: PdfInfo = await readPdf(withMargins.data);
    expect(pdf.pageCount).toBe(1);
    // Same page, smaller image, centered inside the margins
    expectPageSize(pdf.pageSizes[0], A4);
    const margins: number = 2 * POINTS_PER_CM;
    const [before] = await pdfImagePlacements(noMargins.data);
    const [after] = await pdfImagePlacements(withMargins.data);
    expectPlacement(after, expectedPlacement(size, A4, margins));
    expect(after.width).toBeLessThan(before.width);
    expect(after.height).toBeLessThan(before.height);
    expect(Math.min(after.x, after.y)).toBeCloseTo(margins, 1);
    expect(after.x + after.width).toBeLessThanOrEqual(
      A4.width - margins + 0.01,
    );
    expect(after.y + after.height).toBeLessThanOrEqual(
      A4.height - margins + 0.01,
    );
  });

  test('adds margins with 2 decimal places around a page the size of the document', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choosePage(page, 'image');
    await setMargins(page, 1.25);
    const file: DownloadedFile = await exportFile(page);

    const margins: number = 1.25 * POINTS_PER_CM;
    const pdf: PdfInfo = await readPdf(file.data);
    expectPageSize(pdf.pageSizes[0], documentSizePage(size, margins));
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(placement, {
      x: margins,
      y: margins,
      ...documentSizePage(size),
    });
  });

  test('masks and steps the margins with 2 decimal places, up to 10 cm, which still exports a valid Letter page', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choosePage(page, 'letter');
    const margins: Locator = page.getByTestId('margins');
    // Typed like a money field: digits fill from the right, and the field is selected on focus
    // wherever it is tapped, so typing starts over
    await margins.click({ position: { x: 4, y: 8 } });
    await page.keyboard.type('1');
    await expect(margins).toHaveValue('0.01');
    await page.keyboard.type('25');
    await expect(margins).toHaveValue('1.25');
    await page.keyboard.press('Backspace');
    await expect(margins).toHaveValue('0.12');
    // Only digits count: number fields would otherwise take e, +, - and separators
    await page.keyboard.type('e+-,.a');
    await expect(margins).toHaveValue('0.12');
    // The arrows step by 0.01 cm, keeping 2 decimal places
    await page.keyboard.press('ArrowUp');
    await expect(margins).toHaveValue('0.13');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(margins).toHaveValue('0.11');
    await margins.blur();
    await margins.click({ position: { x: 4, y: 8 } });
    await page.keyboard.type('129');
    await expect(margins).toHaveValue('1.29');
    await page.keyboard.press('ArrowUp');
    await expect(margins).toHaveValue('1.30');
    // Never past 10 cm, whether typed or stepped
    await page.keyboard.type('456');
    await expect(margins).toHaveValue('10.00');
    await page.keyboard.type('7');
    await expect(margins).toHaveValue('10.00');
    await page.keyboard.press('ArrowUp');
    await expect(margins).toHaveValue('10.00');
    const file: DownloadedFile = await exportFile(page);

    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageSizes[0]).toEqual(LETTER);
    const [placement] = await pdfImagePlacements(file.data);
    expectPlacement(
      placement,
      expectedPlacement(size, LETTER, 10 * POINTS_PER_CM),
    );
  });

  test('exports several documents as one PDF, one page per document in carousel order', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg', 'receipt.jpg']);
    const [invoice, receipt] = await documentSizes(page);
    expect(invoice).not.toEqual(receipt);
    await expect(
      page.getByRole('radio', { name: 'Um PDF com tudo', exact: true }),
    ).toBeChecked();

    // Pages the size of each document, to tell them apart
    await choosePage(page, 'image');
    const before: string = fileStamp();
    const file: DownloadedFile = await exportFile(page);
    const after: string = fileStamp();

    expectBatchName(file.name, 'pdf', before, after);
    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageCount).toBe(2);
    expectPageSize(pdf.pageSizes[0], documentSizePage(invoice));
    expectPageSize(pdf.pageSizes[1], documentSizePage(receipt));
    expect(await pdfImageSizes(file.data)).toEqual([invoice, receipt]);
    await expect(savedToast(page)).toHaveText(`Arquivo baixado: ${file.name}`);

    // The receipt goes first: the pages follow
    await showDocument(page, 0);
    await page.getByTestId('doc-0').press('Alt+ArrowRight');
    await expect(resultStatus(page)).toHaveText(
      `Documento 2 de 2 · ${sizeText(invoice)}`,
    );
    const reordered: DownloadedFile = await exportFile(page);

    const swapped: PdfInfo = await readPdf(reordered.data);
    expect(swapped.pageCount).toBe(2);
    expectPageSize(swapped.pageSizes[0], documentSizePage(receipt));
    expectPageSize(swapped.pageSizes[1], documentSizePage(invoice));
    expect(await pdfImageSizes(reordered.data)).toEqual([receipt, invoice]);
  });

  test('exports one PDF per document in a ZIP, numbered in carousel order', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg', 'receipt.jpg']);
    const sizes: Size[] = await documentSizes(page);

    await choose(page, 'Um PDF por documento');
    await expect(
      page.getByText('Os PDFs são baixados juntos, num arquivo ZIP.'),
    ).toBeVisible();
    const before: string = fileStamp();
    const file: DownloadedFile = await exportFile(page);
    const after: string = fileStamp();

    expectBatchName(file.name, 'zip', before, after);
    const zip: Map<string, Uint8Array> = readZip(file.data);
    expect([...zip.keys()]).toEqual(['1-invoice.pdf', '2-receipt.pdf']);
    // Each PDF holds its own document, on an A4 page
    for (const [index, pdfData] of [...zip.values()].entries()) {
      const pdf: PdfInfo = await readPdf(pdfData);
      expect(pdf.pageCount).toBe(1);
      expectPageSize(pdf.pageSizes[0], A4);
      expect(await pdfImageSizes(pdfData)).toEqual([sizes[index]]);
      const [placement] = await pdfImagePlacements(pdfData);
      expectPlacement(placement, expectedPlacement(sizes[index], A4, 0));
    }
    await expect(savedToast(page)).toHaveText(`Arquivo baixado: ${file.name}`);
  });

  test('exports a PNG the size of the result, without PDF options', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choose(page, 'PNG');
    await expect(page.getByLabel('Formato da página')).toHaveCount(0);
    await expect(page.getByTestId('margins')).toHaveCount(0);
    // A PNG shows the render itself, not on a page
    await expect(preview(page)).not.toHaveAttribute('data-page-format');
    const shown: PreviewPixels = await settledPixels(page);
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.png');
    expect([...file.data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const image: ImageInfo = readImage(file.data);
    expect(image).toEqual({ format: 'png', ...size });
    // The colors of the photo, as the Color filter is on: the very pixels of the preview
    const decoded: DecodedImage = await decodeImage(page, file.data);
    expect(decoded.maxChannelSpread).toBeGreaterThan(60);
    expect(decoded.checksum).toBe(shown.checksum);
    await expect(savedToast(page)).toHaveText('Arquivo baixado: invoice.png');
  });

  test('exports a JPG the size of the result', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choose(page, 'JPG');
    const file: DownloadedFile = await exportFile(page);

    expect(file.name).toBe('invoice.jpg');
    expect([...file.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...file.data.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(readImage(file.data)).toEqual({ format: 'jpeg', ...size });
    expect(
      (await decodeImage(page, file.data)).maxChannelSpread,
    ).toBeGreaterThan(60);
    await expect(savedToast(page)).toHaveText('Arquivo baixado: invoice.jpg');
  });

  test('exports several documents as PNG or JPG files in a ZIP, numbered in carousel order', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg', 'receipt.jpg']);
    const [invoice, receipt] = await documentSizes(page);

    await choose(page, 'PNG');
    await expect(
      page.getByText('Cada documento vira um arquivo, todos num ZIP.'),
    ).toBeVisible();
    // Only PDFs can be combined
    await expect(
      page.getByRole('radio', { name: 'Um PDF com tudo' }),
    ).toHaveCount(0);
    const before: string = fileStamp();
    const pngs: DownloadedFile = await exportFile(page);
    const after: string = fileStamp();

    expectBatchName(pngs.name, 'zip', before, after);
    const pngZip: Map<string, Uint8Array> = readZip(pngs.data);
    expect([...pngZip.keys()]).toEqual(['1-invoice.png', '2-receipt.png']);
    expect(readImage(pngZip.get('1-invoice.png') ?? new Uint8Array())).toEqual({
      format: 'png',
      ...invoice,
    });
    expect(readImage(pngZip.get('2-receipt.png') ?? new Uint8Array())).toEqual({
      format: 'png',
      ...receipt,
    });

    await choose(page, 'JPG');
    const jpgs: DownloadedFile = await exportFile(page);

    expect(jpgs.name).toMatch(/^documentos-\d{12}\.zip$/);
    const jpgZip: Map<string, Uint8Array> = readZip(jpgs.data);
    expect([...jpgZip.keys()]).toEqual(['1-invoice.jpg', '2-receipt.jpg']);
    expect(readImage(jpgZip.get('1-invoice.jpg') ?? new Uint8Array())).toEqual({
      format: 'jpeg',
      ...invoice,
    });
    expect(readImage(jpgZip.get('2-receipt.jpg') ?? new Uint8Array())).toEqual({
      format: 'jpeg',
      ...receipt,
    });
  });

  test('exports the adjustments of each document, including those applied to all', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg', 'receipt.jpg']);
    const [invoice, receipt] = await documentSizes(page);

    // Grayscale and strong sharpness (so noise reduction) applied to all; only the invoice rotated
    await page.getByTestId('step-2').click();
    await showDocument(page, 0);
    await choose(page, 'Cinza');
    await choose(page, 'Forte');
    await page.getByRole('button', { name: 'Direita', exact: true }).click();
    await page.getByTestId('apply-all').click();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'ajustes' }),
    ).toHaveText('Os ajustes foram aplicados aos 2 documentos.');
    await page.getByTestId('continue').click();
    await expect(page.getByTestId('step-3')).toHaveAttribute(
      'aria-current',
      'step',
    );

    // What the preview shows for each document, with its adjustments: the render itself, for PNG
    await choose(page, 'PNG');
    const shown: PreviewPixels[] = [];
    for (const index of [0, 1]) {
      await showDocument(page, index);
      shown.push(await settledPixels(page));
    }
    expect({ width: shown[0].width, height: shown[0].height }).toEqual({
      width: invoice.height,
      height: invoice.width,
    });
    expect({ width: shown[1].width, height: shown[1].height }).toEqual(receipt);

    const file: DownloadedFile = await exportFile(page);

    const zip: Map<string, Uint8Array> = readZip(file.data);
    expect([...zip.keys()]).toEqual(['1-invoice.png', '2-receipt.png']);
    const first: DecodedImage = await decodeImage(
      page,
      zip.get('1-invoice.png') ?? new Uint8Array(),
    );
    const second: DecodedImage = await decodeImage(
      page,
      zip.get('2-receipt.png') ?? new Uint8Array(),
    );
    // Each file is the very render of the preview: rotated or not, gray, sharpened and smoothed
    expect(first).toEqual({
      width: invoice.height,
      height: invoice.width,
      maxChannelSpread: 0,
      checksum: shown[0].checksum,
    });
    expect(second).toEqual({
      ...receipt,
      maxChannelSpread: 0,
      checksum: shown[1].checksum,
    });
  });

  test('names the files after the uploaded image, without its extension', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await page.goto('/');
    await uploadAs(page, 'invoice.jpg', 'Contract March.final.jpeg');
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await clickContinue(page);
    await resultSize(page);
    await page.getByTestId('continue').click();

    const pdf: DownloadedFile = await exportFile(page);
    expect(pdf.name).toBe('Contract March.final.pdf');
    await expect(savedToast(page)).toHaveText(
      'Arquivo baixado: Contract March.final.pdf',
    );

    await choose(page, 'JPG');
    const jpg: DownloadedFile = await exportFile(page);
    expect(jpg.name).toBe('Contract March.final.jpg');
    await expect(savedToast(page)).toHaveText(
      'Arquivo baixado: Contract March.final.jpg',
    );
  });

  test('New scan goes back to an empty Upload step with the default options', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openExport(page, ['invoice.jpg', 'receipt.jpg']);
    // Options away from the defaults, which a new scan must not keep
    await choose(page, 'Um PDF por documento');
    await choosePage(page, 'letter');
    await setMargins(page, 0.5);
    await choose(page, 'PNG');
    await exportFile(page);
    await expect(savedToast(page)).toBeVisible();

    await page
      .getByRole('button', { name: 'Nova digitalização', exact: true })
      .click();

    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(
      page.getByText('Fotografe ou envie imagens dos documentos'),
    ).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    for (const step of ['step-1', 'step-2', 'step-3']) {
      await expect(page.getByTestId(step)).toBeDisabled();
    }

    // A new scan starts from the default adjustments and export options
    await uploadImages(page, ['receipt.jpg', 'invoice.jpg']);
    await page.getByTestId('upload-continue').click();
    await clickContinue(page);
    await resultSize(page);
    await expect(
      page.getByRole('radio', { name: 'Colorido', exact: true }),
    ).toBeChecked();
    await page.getByTestId('continue').click();
    await expect(page.getByTestId('step-3')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(
      page.getByRole('radio', { name: 'PDF', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Um PDF com tudo', exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel('Formato da página')).toHaveValue('a4');
    await expect(page.getByTestId('margins')).toHaveValue('0.00');
    const file: DownloadedFile = await exportFile(page);
    expect(file.name).toMatch(/^documentos-\d{12}\.pdf$/);
    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageSizes).toHaveLength(2);
    for (const pageSize of pdf.pageSizes) expectPageSize(pageSize, A4);
  });
});
