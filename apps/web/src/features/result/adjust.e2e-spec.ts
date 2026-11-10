import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  choose,
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
  type Transients,
  watchTransients,
} from '@/test-support/e2e/result';

/** Time for a new render of the preview, which runs OpenCV. */
const RENDER_TIMEOUT: { timeout: number } = { timeout: 30_000 };

/** The canvas that shows the render of the document on display. */
function preview(page: Page): Locator {
  return page.getByTestId('result');
}

/** Reads one measure of the preview pixels, for `expect.poll`. */
function measure(page: Page, key: keyof PreviewPixels): () => Promise<number> {
  return async (): Promise<number> => (await previewPixels(page))[key];
}

/** The loading spinner over the preview, for `watchTransients`. */
const SPINNER: string = '[data-testid="loading"]';

/** The preview faded while a new render runs, for `watchTransients`. */
const BUSY_PREVIEW: string = '[data-testid="result"].is-busy';

/** The labels of the rotate buttons. */
const ROTATE_LABELS: Record<'Left' | 'Right', string> = {
  Left: 'Esquerda',
  Right: 'Direita',
};

/** Rotates the document on display a quarter turn. */
async function rotate(page: Page, direction: 'Left' | 'Right'): Promise<void> {
  await page
    .getByRole('button', { name: ROTATE_LABELS[direction], exact: true })
    .click();
}

/** The width and the height of a size, swapped, as a quarter turn does. */
const swapped = (size: Size): Size => ({
  width: size.height,
  height: size.width,
});

test.describe('Adjust step', (): void => {
  test('shows the result size of the cropped document, matching the preview canvas', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);

    const size: Size = await resultSize(page);
    // The invoice sheet is taller than wide, a bit smaller than the 1600 × 1200 photo
    expect(size.width).toBeGreaterThan(600);
    expect(size.width).toBeLessThan(size.height);
    expect(size.height).toBeLessThan(1200);
    await expect(resultStatus(page)).toHaveText(sizeText(size));
    await expect(preview(page)).toHaveJSProperty('width', size.width);
    await expect(preview(page)).toHaveJSProperty('height', size.height);
    await expect(
      page.getByRole('img', { name: 'Prévia do documento 1, recortado' }),
    ).toBeVisible();
    // Only one document: nothing to copy the adjustments to
    await expect(page.getByTestId('apply-all')).toHaveCount(0);
  });

  test('swaps the result size on each quarter turn, left or right, and returns after four turns', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    const original: Size = await resultSize(page);
    const originalPixels: PreviewPixels = await previewPixels(page);

    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      sizeText(swapped(original)),
      RENDER_TIMEOUT,
    );
    await expect(preview(page)).toHaveJSProperty('width', original.height);
    await expect(preview(page)).toHaveJSProperty('height', original.width);

    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      sizeText(original),
      RENDER_TIMEOUT,
    );
    // Upside down: same size, different pixels
    const halfTurn: PreviewPixels = await settledPixels(page);
    expect(halfTurn.checksum).not.toBe(originalPixels.checksum);

    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      sizeText(swapped(original)),
      RENDER_TIMEOUT,
    );

    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      sizeText(original),
      RENDER_TIMEOUT,
    );
    // Four turns are no turn at all: the very same pixels as before rotating
    await expect
      .poll(measure(page, 'checksum'), RENDER_TIMEOUT)
      .toBe(originalPixels.checksum);

    await rotate(page, 'Left');
    await expect(resultStatus(page)).toHaveText(
      sizeText(swapped(original)),
      RENDER_TIMEOUT,
    );
    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      sizeText(original),
      RENDER_TIMEOUT,
    );
    await expect
      .poll(measure(page, 'checksum'), RENDER_TIMEOUT)
      .toBe(originalPixels.checksum);
  });

  test('says Applying… over the faded preview while a new render runs, then the size of the new one', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);
    await expect(page.getByTestId('loading')).toHaveCount(0);
    await expect(preview(page)).not.toHaveClass(/is-busy/);

    // OpenCV blocks the page while it renders: the loading state is noted as it happens
    await watchTransients(page, [SPINNER, BUSY_PREVIEW]);
    await choose(page, 'Cinza');
    await expect(resultStatus(page)).toHaveText(sizeText(size), RENDER_TIMEOUT);

    // The size only shows up with the new render already drawn
    expect((await previewPixels(page)).maxChannelSpread).toBe(0);
    const seen: Transients = await seenTransients(page);
    expect(seen.statuses).toEqual([
      sizeText(size),
      'Aplicando…',
      sizeText(size),
    ]);
    // Meanwhile the previous render stayed, faded, under a spinner
    expect(seen.selectors).toEqual(
      expect.arrayContaining([SPINNER, BUSY_PREVIEW]),
    );
    await expect(page.getByTestId('loading')).toHaveCount(0);
    await expect(preview(page)).not.toHaveClass(/is-busy/);
  });

  test('keeps the colors of the photo with the Color filter', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);

    await expect(
      page.getByRole('radio', { name: 'Colorido', exact: true }),
    ).toBeChecked();
    await expect(preview(page)).toHaveAttribute('data-filter', 'none');
    const pixels: PreviewPixels = await settledPixels(page);
    expect(pixels.maxChannelSpread).toBeGreaterThan(60);
    expect(pixels.colorfulShare).toBeGreaterThan(0.005);
    expect(pixels.midtoneShare).toBeGreaterThan(0.5);
  });

  test('turns every pixel gray with the Grayscale filter, and back to color with Color', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);
    const color: PreviewPixels = await previewPixels(page);

    await choose(page, 'Cinza');
    await expect(preview(page)).toHaveAttribute('data-filter', 'grayscale');
    await expect
      .poll(measure(page, 'maxChannelSpread'), RENDER_TIMEOUT)
      .toBe(0);
    const gray: PreviewPixels = await settledPixels(page);
    // r = g = b everywhere, with shades of gray kept, at the same size
    expect(gray.maxChannelSpread).toBe(0);
    expect(gray.midtoneShare).toBeGreaterThan(0.5);
    expect({ width: gray.width, height: gray.height }).toEqual(size);
    await expect(resultStatus(page)).toHaveText(sizeText(size));

    // Back to a render made before: shown again without a new render, so without a loading state
    await watchTransients(page, [SPINNER, BUSY_PREVIEW]);
    await choose(page, 'Colorido');
    await expect(preview(page)).toHaveAttribute('data-filter', 'none');
    await expect
      .poll(measure(page, 'checksum'), RENDER_TIMEOUT)
      .toBe(color.checksum);
    await expect(resultStatus(page)).toHaveText(sizeText(size));
    expect((await seenTransients(page)).selectors).toEqual([]);
  });

  test('leaves only black and white pixels with the Black and white filter', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    const size: Size = await resultSize(page);

    await choose(page, 'Preto e branco');
    await expect(preview(page)).toHaveAttribute('data-filter', 'bw');
    await expect
      .poll(measure(page, 'midtoneShare'), RENDER_TIMEOUT)
      .toBeLessThan(0.001);
    const bw: PreviewPixels = await settledPixels(page);
    expect(bw.maxChannelSpread).toBe(0);
    expect(bw.midtoneShare).toBeLessThan(0.001);
    // A page with text: both black and white are there, not a blank sheet
    expect(bw.edgeEnergy).toBeGreaterThan(1);
    expect({ width: bw.width, height: bw.height }).toEqual(size);
  });

  test('sharpens the preview, Strong more than Soft, and None restores it', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg']);
    await expect(
      page.getByRole('radio', { name: 'Sem ajuste', exact: true }),
    ).toBeChecked();
    const plain: PreviewPixels = await settledPixels(page);

    // The noise reduction that comes with any sharpness smooths the flat areas first, so Soft
    // gains less edge energy than a sharpening alone would
    await choose(page, 'Suave');
    await expect
      .poll(measure(page, 'edgeEnergy'), RENDER_TIMEOUT)
      .toBeGreaterThan(plain.edgeEnergy * 1.04);
    const soft: PreviewPixels = await settledPixels(page);
    expect(soft.checksum).not.toBe(plain.checksum);

    await choose(page, 'Forte');
    await expect
      .poll(measure(page, 'edgeEnergy'), RENDER_TIMEOUT)
      .toBeGreaterThan(soft.edgeEnergy * 1.1);
    const strong: PreviewPixels = await settledPixels(page);
    expect(strong.checksum).not.toBe(soft.checksum);
    // Sharpening keeps the colors and the size
    expect(strong.maxChannelSpread).toBeGreaterThan(60);
    expect(strong.width).toBe(plain.width);
    expect(strong.height).toBe(plain.height);

    await choose(page, 'Sem ajuste');
    await expect
      .poll(measure(page, 'checksum'), RENDER_TIMEOUT)
      .toBe(plain.checksum);
  });

  test('applies color and sharpness to every other document, but not the rotation', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    // The sizes before any adjustment, to tell whether a rotation was copied
    const sizes: Size[] = [];
    for (const index of [0, 1, 2]) {
      await showDocument(page, index);
      sizes.push(await resultSize(page));
    }
    await showDocument(page, 1);
    const receiptColor: PreviewPixels = await settledPixels(page);
    expect(receiptColor.maxChannelSpread).toBeGreaterThan(60);

    await showDocument(page, 0);
    await choose(page, 'Cinza');
    await choose(page, 'Forte');
    await rotate(page, 'Right');
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 3 · ${sizeText(swapped(sizes[0]))}`,
      RENDER_TIMEOUT,
    );

    await page.getByTestId('apply-all').click();
    const toast: Locator = page.getByTestId('toast').filter({
      hasText: 'Os ajustes foram aplicados aos 3 documentos.',
    });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-kind', 'success');

    for (const index of [1, 2]) {
      await showDocument(page, index);
      await expect(
        page.getByRole('radio', { name: 'Cinza', exact: true }),
      ).toBeChecked();
      await expect(
        page.getByRole('radio', { name: 'Forte', exact: true }),
      ).toBeChecked();
      await expect(preview(page)).toHaveAttribute('data-filter', 'grayscale');
      // Not rotated: the size it had before
      await expect(resultStatus(page)).toHaveText(
        `Documento ${String(index + 1)} de 3 · ${sizeText(sizes[index])}`,
        RENDER_TIMEOUT,
      );
    }

    // The preview of the receipt really is gray now
    await showDocument(page, 1);
    await expect
      .poll(measure(page, 'maxChannelSpread'), RENDER_TIMEOUT)
      .toBe(0);

    // The source document keeps its own rotation
    await showDocument(page, 0);
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 3 · ${sizeText(swapped(sizes[0]))}`,
      RENDER_TIMEOUT,
    );
    await expect(
      page.getByRole('radio', { name: 'Cinza', exact: true }),
    ).toBeChecked();
  });

  test('counts the documents in the Apply to all notice', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg']);

    await choose(page, 'Preto e branco');
    await page.getByTestId('apply-all').click();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'ajustes' }),
    ).toHaveText('Os ajustes foram aplicados aos 2 documentos.');

    await showDocument(page, 1);
    await expect(
      page.getByRole('radio', { name: 'Preto e branco', exact: true }),
    ).toBeChecked();
    await expect
      .poll(measure(page, 'midtoneShare'), RENDER_TIMEOUT)
      .toBeLessThan(0.001);
  });

  test('keeps separate adjustments for each document', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openAdjust(page, ['invoice.jpg', 'receipt.jpg']);
    const invoice: Size = await resultSize(page);
    await showDocument(page, 1);
    const receipt: Size = await resultSize(page);

    // The receipt: grayscale, soft and rotated left
    await choose(page, 'Cinza');
    await choose(page, 'Suave');
    await rotate(page, 'Left');
    await expect(resultStatus(page)).toHaveText(
      `Documento 2 de 2 · ${sizeText(swapped(receipt))}`,
      RENDER_TIMEOUT,
    );

    // The invoice: black and white with strong sharpness
    await showDocument(page, 0);
    await expect(
      page.getByRole('radio', { name: 'Colorido', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Sem ajuste', exact: true }),
    ).toBeChecked();
    await choose(page, 'Preto e branco');
    await choose(page, 'Forte');
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 2 · ${sizeText(invoice)}`,
      RENDER_TIMEOUT,
    );
    await expect
      .poll(measure(page, 'midtoneShare'), RENDER_TIMEOUT)
      .toBeLessThan(0.001);

    // Back to the receipt: its own options, untouched by the invoice ones
    await showDocument(page, 1);
    await expect(
      page.getByRole('radio', { name: 'Cinza', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Suave', exact: true }),
    ).toBeChecked();
    await expect(preview(page)).toHaveAttribute('data-filter', 'grayscale');
    await expect(resultStatus(page)).toHaveText(
      `Documento 2 de 2 · ${sizeText(swapped(receipt))}`,
      RENDER_TIMEOUT,
    );
    const gray: PreviewPixels = await settledPixels(page);
    expect(gray.maxChannelSpread).toBe(0);
    expect(gray.midtoneShare).toBeGreaterThan(0.5);

    // And the invoice still has its own
    await showDocument(page, 0);
    await expect(
      page.getByRole('radio', { name: 'Preto e branco', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Forte', exact: true }),
    ).toBeChecked();
    await expect(preview(page)).toHaveAttribute('data-filter', 'bw');
    await expect(resultStatus(page)).toHaveText(
      `Documento 1 de 2 · ${sizeText(invoice)}`,
      RENDER_TIMEOUT,
    );
  });
});
