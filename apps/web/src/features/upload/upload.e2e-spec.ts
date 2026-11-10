import {
  expect,
  type JSHandle,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

import {
  clickContinue,
  documentTiles,
  type DownloadedFile,
  downloadFrom,
  editorCorners,
  fixturePath,
  type ImageInfo,
  openApp,
  readImage,
  readZip,
  uploadImages,
} from '@/test-support/e2e/app';
import {
  dataTransferWith,
  dragTile,
  dropFiles,
  fixtureFile,
  photoInEditor,
  photosInCrop,
  textFile,
  uploadedPhotos,
} from '@/test-support/e2e/upload';

/** What the init script of the progress tests records about the import progress bar. */
interface ProgressWindow {
  progressLabels: string[];
  progressValues: number[];
}

/** Records every label and value the import progress bar shows, from the moment the page loads. */
async function recordImportProgress(page: Page): Promise<void> {
  await page.addInitScript((): void => {
    const progress: ProgressWindow = window as unknown as ProgressWindow;
    progress.progressLabels = [];
    progress.progressValues = [];
    new MutationObserver((): void => {
      const bar: Element | null = document.querySelector(
        '[data-testid="import-progress"] [role="progressbar"]',
      );
      if (!bar) return;
      const label: string | null = bar.getAttribute('aria-label');
      const value: number = Number(bar.getAttribute('aria-valuenow'));
      if (label && progress.progressLabels.at(-1) !== label)
        progress.progressLabels.push(label);
      if (progress.progressValues.at(-1) !== value)
        progress.progressValues.push(value);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

/** What {@link recordImportProgress} has recorded in the page so far. */
async function recordedProgress(page: Page): Promise<ProgressWindow> {
  return page.evaluate((): ProgressWindow => ({
    progressLabels: (window as unknown as ProgressWindow).progressLabels,
    progressValues: (window as unknown as ProgressWindow).progressValues,
  }));
}

/** The message of the only toast of the given kind. */
function toastMessage(page: Page, kind: 'warning' | 'error'): Locator {
  return page.locator(`[data-testid="toast"][data-kind="${kind}"] p`);
}

/** The heading of the Upload step. */
function uploadHeading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

/** The compact carousel under the preview of the Crop, Adjust and Export steps. */
function compactCarousel(page: Page): Locator {
  return page.locator('.doc-carousel.is-compact');
}

/** The numbers drawn on the tiles, in carousel order. */
async function tileNumbers(page: Page): Promise<string[]> {
  return page.locator('.doc-tile-n').allTextContents();
}

/**
 * Where to press a tile with the mouse: its center, a bit low to stay clear of the remove button.
 */
async function tileCenter(
  page: Page,
  index: number,
): Promise<{ x: number; y: number }> {
  const box: { x: number; y: number; width: number; height: number } | null =
    await page.getByTestId(`doc-${String(index)}`).boundingBox();
  if (!box) throw new Error(`Tile ${String(index)} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
}

/** Goes from the Upload step to the Export step, through Crop and Adjust. */
async function goToExport(page: Page): Promise<void> {
  await page.getByTestId('upload-continue').click();
  await expect(page.getByTestId('corner-editor')).toBeVisible();
  await clickContinue(page);
  await expect(page.getByTestId('result')).toBeVisible();
  await clickContinue(page);
  await expect(page.getByTestId('download')).toBeVisible();
}

/** Exports every document as PNG and returns the downloaded ZIP. */
async function exportPngZip(page: Page): Promise<Map<string, Uint8Array>> {
  // The radio button is drawn by its label, which takes the clicks
  await page.locator('.segmented label').filter({ hasText: /^PNG$/ }).click();
  await expect(page.getByRole('radio', { name: 'PNG' })).toBeChecked();
  await expect(page.getByTestId('download')).toBeEnabled({ timeout: 60_000 });
  const file: DownloadedFile = await downloadFrom(page, async () => {
    await page.getByTestId('download').click();
  });
  expect(file.name).toMatch(/^documentos-\d{12}\.zip$/);
  return readZip(file.data);
}

/** Width over height of an exported image. */
function aspect(image: ImageInfo): number {
  return image.width / image.height;
}

/** Checks that an exported PNG is the cropped sheet of the given photo. */
function expectCroppedPhoto(data: Uint8Array | undefined, photo: string): void {
  expect(data, `${photo} is in the ZIP`).toBeDefined();
  const image: ImageInfo = readImage(data ?? new Uint8Array());
  expect(image.format).toBe('png');
  if (photo === 'blank') {
    // No document: the crop is the whole photo
    expect(image).toEqual({ format: 'png', width: 800, height: 600 });
  } else if (photo === 'invoice') {
    // The invoice sheet is almost square: about 810 × 890 px
    expect(aspect(image)).toBeGreaterThan(0.85);
    expect(aspect(image)).toBeLessThan(1);
    expect(image.height).toBeGreaterThan(830);
    expect(image.height).toBeLessThan(950);
  } else {
    // The receipt is narrow: about 690 × 1035 px
    expect(aspect(image)).toBeGreaterThan(0.6);
    expect(aspect(image)).toBeLessThan(0.72);
    expect(image.height).toBeGreaterThan(980);
    expect(image.height).toBeLessThan(1100);
  }
}

test.describe('Upload step', (): void => {
  test('uploading one image shows it numbered in the carousel', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await expect(uploadHeading(page)).toHaveText(
      'Fotografe ou envie imagens dos documentos',
    );
    await expect(page.getByTestId('step-1')).toBeDisabled();

    await uploadImages(page, ['invoice.jpg']);

    await expect(uploadHeading(page)).toHaveText('Você enviou 1 imagem');
    await expect(page.getByTestId('upload-files')).toBeHidden();
    await expect(documentTiles(page)).toHaveCount(1);
    await expect(page.getByTestId('doc-0')).toHaveAccessibleName('Documento 1');
    await expect(page.getByTestId('remove-0')).toHaveAccessibleName(
      'Remover documento 1',
    );
    expect(await tileNumbers(page)).toEqual(['1']);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice']);
    await expect(page.getByTestId('step-1')).toBeEnabled();
    await expect(page.getByTestId('upload-continue')).toBeEnabled();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('uploading several images at once keeps the order they were chosen in', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await expect(page.getByTestId('file-input')).toHaveAttribute(
      'accept',
      'image/*',
    );
    await expect(page.getByTestId('file-input')).toHaveAttribute(
      'multiple',
      '',
    );

    await uploadImages(page, ['receipt.jpg', 'invoice.jpg']);

    await expect(uploadHeading(page)).toHaveText('Você enviou 2 imagens');
    await expect(page.getByTestId('doc-0')).toHaveAccessibleName('Documento 1');
    await expect(page.getByTestId('doc-1')).toHaveAccessibleName('Documento 2');
    expect(await tileNumbers(page)).toEqual(['1', '2']);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'invoice']);
  });

  test('images added from the carousel go after the ones already there', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    await expect(page.getByTestId('add-upload')).toBeVisible();

    await uploadImages(page, ['blank.png', 'receipt.jpg']);

    await expect(uploadHeading(page)).toHaveText('Você enviou 3 imagens');
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'blank', 'receipt']);
    // Adding from the Upload step stays there
    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  test('the import progress counts the images being opened and detected, then goes away', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await recordImportProgress(page);
    await openApp(page);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('upload-files').click(),
    ]);
    await chooser.setFiles([
      fixturePath('invoice.jpg'),
      fixturePath('receipt.jpg'),
    ]);

    // While importing, the progress covers the workspace and the steps are locked
    await expect(page.getByTestId('loading-overlay')).toBeVisible();
    await expect(page.getByTestId('step-0')).toBeDisabled();
    await expect(
      page.getByRole('progressbar', { name: /imagem [12] de 2…$/ }),
    ).toBeVisible();

    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('loading-overlay')).toBeHidden();
    await expect(page.getByTestId('step-0')).toBeEnabled();
    await expect(page.getByTestId('step-1')).toBeEnabled();

    const { progressLabels, progressValues }: ProgressWindow =
      await recordedProgress(page);
    expect(progressLabels).toEqual([
      'Enviando a imagem 1 de 2…',
      'Detectando o documento na imagem 1 de 2…',
      'Enviando a imagem 2 de 2…',
      'Detectando o documento na imagem 2 de 2…',
    ]);
    // Opening and detecting each image are two of the five steps of the import. The last step,
    // putting the import together, may reach the screen in the same paint as the end (100)
    expect(progressValues.slice(0, 4)).toEqual([0, 20, 40, 60]);
    expect(progressValues.at(-1)).toBe(100);
    expect([
      [0, 20, 40, 60, 100],
      [0, 20, 40, 60, 80, 100],
    ]).toContainEqual(progressValues);
  });

  test('importing a single image describes it without counting', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await recordImportProgress(page);
    await openApp(page);

    await uploadImages(page, ['receipt.jpg']);

    const { progressLabels, progressValues }: ProgressWindow =
      await recordedProgress(page);
    expect(progressLabels).toEqual([
      'Enviando a imagem…',
      'Detectando o documento na imagem…',
    ]);
    expect([
      [0, 33, 100],
      [0, 33, 67, 100],
    ]).toContainEqual(progressValues);
  });

  test('images dropped on the empty upload step are imported in the order dropped', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    const screen: Locator = page.locator('.upload-screen');
    const card: Locator = page.locator('.add-card-large');
    const dataTransfer: JSHandle<DataTransfer> = await dataTransferWith(page, [
      await fixtureFile('receipt.jpg'),
      await fixtureFile('invoice.jpg'),
    ]);

    await screen.dispatchEvent('dragenter', { dataTransfer });
    await screen.dispatchEvent('dragover', { dataTransfer });
    // The card shows that it accepts the drop
    await expect(card).toHaveClass(/is-over/);
    await screen.dispatchEvent('drop', { dataTransfer });

    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    await expect(uploadHeading(page)).toHaveText('Você enviou 2 imagens');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'invoice']);
  });

  test('dragging images away from the empty upload step clears the drop highlight', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    const screen: Locator = page.locator('.upload-screen');
    const card: Locator = page.locator('.add-card-large');
    const dataTransfer: JSHandle<DataTransfer> = await dataTransferWith(page, [
      await fixtureFile('invoice.jpg'),
    ]);

    await screen.dispatchEvent('dragover', { dataTransfer });
    await expect(card).toHaveClass(/is-over/);
    await screen.dispatchEvent('dragleave', { dataTransfer });
    await expect(card).not.toHaveClass(/is-over/);
    await expect(documentTiles(page)).toHaveCount(0);
  });

  test('images dropped on the carousel are added once, after the existing ones', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);

    const carousel: Locator = page.locator('.doc-carousel');
    const addTile: Locator = page.locator('.add-tile');
    const dataTransfer: JSHandle<DataTransfer> = await dataTransferWith(page, [
      await fixtureFile('blank.png'),
    ]);
    await carousel.dispatchEvent('dragenter', { dataTransfer });
    await carousel.dispatchEvent('dragover', { dataTransfer });
    // The add tile shows that the carousel accepts the drop
    await expect(addTile).toHaveClass(/is-over/);
    // The screen behind the carousel also accepts drops: the file must not be imported twice
    await carousel.dispatchEvent('drop', { dataTransfer });
    await expect(addTile).not.toHaveClass(/is-over/);

    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    await expect(documentTiles(page)).toHaveCount(2);
    await expect(uploadHeading(page)).toHaveText('Você enviou 2 imagens');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'blank']);
  });

  test('a file that is not an image, dropped with images, is left out with a warning', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);

    await dropFiles(page, page.locator('.upload-screen'), [
      textFile('notes.txt'),
      await fixtureFile('invoice.jpg'),
    ]);

    // One assertion for kind and message: the toast goes away by itself after a few seconds
    await expect(toastMessage(page, 'warning')).toHaveText(
      '1 arquivo não pôde ser aberto.',
      { timeout: 60_000 },
    );
    await expect(documentTiles(page)).toHaveCount(1);
    await expect(uploadHeading(page)).toHaveText('Você enviou 1 imagem');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice']);
  });

  test('dropping only files that are not images adds nothing and shows an error', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);

    await dropFiles(page, page.locator('.upload-screen'), [
      textFile('notes.txt'),
    ]);

    await expect(toastMessage(page, 'error')).toHaveText(
      'Não foi possível abrir este arquivo. Envie uma imagem JPG, PNG ou WebP.',
      { timeout: 60_000 },
    );
    await expect(page.getByTestId('loading-overlay')).toBeHidden();
    // The drop ended, so the card no longer shows that it accepts one
    await expect(page.locator('.add-card-large')).not.toHaveClass(/is-over/);
    await expect(documentTiles(page)).toHaveCount(0);
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(page.getByTestId('step-1')).toBeDisabled();
  });

  test('a photo with no document is imported and its corners are the corners of the image', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['blank.png']);

    await expect(page.getByTestId('toast')).toHaveCount(0);
    await expect(documentTiles(page)).toHaveCount(1);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['blank']);

    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 800 600',
    );
    expect(await editorCorners(page)).toEqual([
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 800, y: 600 },
      { x: 0, y: 600 },
    ]);
    // The whole image is a valid crop
    await expect(page.getByTestId('doc-0')).toHaveAccessibleName('Documento 1');
    await expect(page.getByTestId('crop')).toBeEnabled();
  });
});

test.describe('Removing documents', (): void => {
  test('removing a document renumbers the ones after it', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    await page.getByTestId('remove-1').click();

    await expect(documentTiles(page)).toHaveCount(2);
    await expect(uploadHeading(page)).toHaveText('Você enviou 2 imagens');
    expect(await tileNumbers(page)).toEqual(['1', '2']);
    await expect(page.getByTestId('doc-1')).toHaveAccessibleName('Documento 2');
    await expect(page.getByTestId('remove-1')).toHaveAccessibleName(
      'Remover documento 2',
    );
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'blank']);
  });

  test('removing the last document goes back to the empty upload step', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);

    await page.getByTestId('remove-0').click();
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt']);
    await expect(uploadHeading(page)).toHaveText('Você enviou 1 imagem');
    await page.getByTestId('remove-0').click();

    await expect(documentTiles(page)).toHaveCount(0);
    await expect(uploadHeading(page)).toHaveText(
      'Fotografe ou envie imagens dos documentos',
    );
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(page.getByTestId('upload-camera')).toBeVisible();
    await expect(page.getByTestId('step-1')).toBeDisabled();

    // The empty step works as before
    await uploadImages(page, ['blank.png']);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['blank']);
  });
});

test.describe('Reordering in the Upload step', (): void => {
  test('Alt + arrow keys move the focused document, and the focus follows it', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    // In the Upload step, the focusable part of a tile is its remove button
    await page.getByTestId('remove-0').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'invoice', 'blank']);
    await expect(page.getByTestId('remove-1')).toBeFocused();

    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'blank', 'invoice']);
    await expect(page.getByTestId('remove-2')).toBeFocused();

    // Already the last one: nothing moves
    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'blank', 'invoice']);

    // Arrows without Alt do not reorder
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'blank', 'invoice']);

    await page.getByTestId('remove-1').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['blank', 'receipt', 'invoice']);
    await expect(page.getByTestId('remove-0')).toBeFocused();

    // Already the first one: nothing moves
    await page.keyboard.press('Alt+ArrowLeft');
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['blank', 'receipt', 'invoice']);
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
  });

  test('dragging a tile with the mouse over another moves it there', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    // The first one past the center of the last one: it becomes the last
    await dragTile(page, 0, 2, 20);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'blank', 'invoice']);

    // The last one before the center of the first one: it becomes the first
    await dragTile(page, 2, 0, -20);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'receipt', 'blank']);

    // The second one past the center of the third one: they swap
    await dragTile(page, 1, 2, 20);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'blank', 'receipt']);
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
  });

  test('a mouse press that barely moves does not reorder', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);
    const carousel: Locator = page.locator('.doc-carousel');
    const dragged: Locator = page.locator('.doc-item.is-dragging');
    const start: { x: number; y: number } = await tileCenter(page, 0);

    // Moved less than the 5 px that start a drag: nothing is dragged
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 3, start.y, { steps: 3 });
    await expect(dragged).toHaveCount(0);
    await expect(carousel).not.toHaveClass(/is-sorting/);

    // Past 5 px, the tile is dragged; dropped back where it started, the order stays
    await page.mouse.move(start.x + 8, start.y, { steps: 3 });
    await expect(dragged).toHaveCount(1);
    await expect(carousel).toHaveClass(/is-sorting/);
    await page.mouse.move(start.x, start.y, { steps: 3 });
    await page.mouse.up();

    await expect(dragged).toHaveCount(0);
    await expect(carousel).not.toHaveClass(/is-sorting/);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'receipt']);
    expect(await tileNumbers(page)).toEqual(['1', '2']);
  });

  test('in Crop, a mouse press that barely moves is a click and selects the document', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('doc-0')).toHaveAttribute(
      'aria-current',
      'true',
    );

    // A drag would swallow the click; a 3 px wobble must not
    const start: { x: number; y: number } = await tileCenter(page, 1);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 3, start.y, { steps: 3 });
    await page.mouse.up();

    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('receipt');
    expect(await photosInCrop(page)).toEqual(['invoice', 'receipt']);
  });

  test('the carousel order is the export order', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    await dragTile(page, 1, 0, -20);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'invoice', 'blank']);

    await goToExport(page);
    const zip: Map<string, Uint8Array> = await exportPngZip(page);

    expect([...zip.keys()]).toEqual([
      '1-receipt.png',
      '2-invoice.png',
      '3-blank.png',
    ]);
    expectCroppedPhoto(zip.get('1-receipt.png'), 'receipt');
    expectCroppedPhoto(zip.get('2-invoice.png'), 'invoice');
    expectCroppedPhoto(zip.get('3-blank.png'), 'blank');
  });
});

test.describe('Carousel in the later steps', (): void => {
  test('a compact carousel stays below the preview in Crop, Adjust and Export', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);

    const expectBelow = async (preview: Locator): Promise<void> => {
      await expect(preview).toBeVisible();
      await expect(compactCarousel(page)).toBeVisible();
      await expect(documentTiles(page)).toHaveCount(2);
      await expect(page.getByTestId('add-upload')).toBeVisible();
      const previewBox: { y: number; height: number } | null =
        await preview.boundingBox();
      const carouselBox: { y: number; height: number } | null =
        await compactCarousel(page).boundingBox();
      if (!previewBox || !carouselBox) throw new Error('Not on screen');
      expect(carouselBox.y).toBeGreaterThanOrEqual(
        previewBox.y + previewBox.height - 1,
      );
    };

    await page.getByTestId('upload-continue').click();
    await expectBelow(page.getByTestId('corner-editor'));
    await expect(page.getByTestId('doc-0')).toHaveAttribute(
      'aria-current',
      'true',
    );

    await clickContinue(page);
    await expectBelow(page.getByTestId('result'));

    await clickContinue(page);
    await expect(page.getByTestId('download')).toBeVisible();
    await expectBelow(page.getByTestId('result'));
    expect(await tileNumbers(page)).toEqual(['1', '2']);
  });

  test('removing in Crop selects the neighbor, and removing the last one goes back to Upload', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();

    // The active document (the first) is removed: the next one takes its place
    await page.getByTestId('remove-0').click();
    await expect(documentTiles(page)).toHaveCount(2);
    await expect(page.getByTestId('doc-0')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-1')).toHaveAccessibleName('Documento 2');
    expect(await tileNumbers(page)).toEqual(['1', '2']);
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('receipt');

    // The last one, active, is removed: the one before it takes its place
    await page.getByTestId('doc-1').click();
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('blank');
    await page.getByTestId('remove-1').click();
    await expect(documentTiles(page)).toHaveCount(1);
    await expect(page.getByTestId('doc-0')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('receipt');

    await page.getByTestId('remove-0').click();
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(uploadHeading(page)).toHaveText(
      'Fotografe ou envie imagens dos documentos',
    );
    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('step-1')).toBeDisabled();
  });

  test('removing the last document in Export goes back to the empty Upload step', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    await goToExport(page);

    await page.getByTestId('remove-0').click();

    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(0);
    await expect(uploadHeading(page)).toHaveText(
      'Fotografe ou envie imagens dos documentos',
    );
    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
    // With no document, the later steps are locked again
    await expect(page.getByTestId('step-1')).toBeDisabled();
    await expect(page.getByTestId('step-3')).toBeDisabled();
  });

  test('removing a document that is not on display in Crop keeps the one on display', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await page.getByTestId('doc-2').click();
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('blank');

    // The first one goes: the blank photo stays on display, now as the second document
    await page.getByTestId('remove-0').click();

    await expect(documentTiles(page)).toHaveCount(2);
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-0')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('blank');
    expect(await photosInCrop(page)).toEqual(['receipt', 'blank']);
  });

  test('Alt + arrow keys reorder in Crop, and the selection follows the document', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();

    await page.getByTestId('doc-0').focus();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-1')).toBeFocused();
    await expect(page.getByTestId('doc-0')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(await photoInEditor(page)).toBe('invoice');

    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.getByTestId('doc-2')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-2')).toBeFocused();
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);

    expect(await photosInCrop(page)).toEqual(['receipt', 'blank', 'invoice']);
  });

  test('dragging with the mouse in Export reorders without selecting, and the export follows', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);
    await goToExport(page);
    await expect(page.getByTestId('result-size')).toContainText(
      'Documento 1 de 2',
    );

    // The receipt goes before the invoice, which stays on display
    await dragTile(page, 1, 0, -20);

    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('doc-0')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('result-size')).toContainText(
      'Documento 2 de 2',
    );

    const zip: Map<string, Uint8Array> = await exportPngZip(page);
    expect([...zip.keys()]).toEqual(['1-receipt.png', '2-invoice.png']);
    expectCroppedPhoto(zip.get('1-receipt.png'), 'receipt');
    expectCroppedPhoto(zip.get('2-invoice.png'), 'invoice');
  });

  test('adding images from Adjust goes to Crop with the first new one selected', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await clickContinue(page);
    await expect(page.getByTestId('result')).toBeVisible();
    await expect(page.getByTestId('step-2')).toHaveAttribute(
      'aria-current',
      'step',
    );

    await uploadImages(page, ['receipt.jpg', 'blank.png']);

    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(3);
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('receipt');
    expect(await photosInCrop(page)).toEqual(['invoice', 'receipt', 'blank']);
  });

  test('images dropped on the carousel in Export are added, and Crop opens on the first new one', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    await goToExport(page);

    await dropFiles(page, compactCarousel(page), [
      await fixtureFile('blank.png'),
      await fixtureFile('receipt.jpg'),
    ]);

    await expect(documentTiles(page)).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('doc-1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('blank');
    // In the order dropped, after the one already there
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    expect(await photosInCrop(page)).toEqual(['invoice', 'blank', 'receipt']);
  });

  test('adding images from Crop stays in Crop with the first new one selected', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();

    await uploadImages(page, ['blank.png']);

    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('doc-2')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect
      .poll(async (): Promise<string> => photoInEditor(page))
      .toBe('blank');
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
  });
});
