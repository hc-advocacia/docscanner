import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  clickContinue,
  cornerOnScreen,
  documentTiles,
  editorCorners,
  type Fixture,
  FIXTURE_CORNERS,
  maxCornerError,
  openApp,
  type Point,
  type Quad,
  uploadImages,
} from '@/test-support/e2e/app';

/** How far, in photo pixels, a detected corner may be from where the sheet really is. */
const DETECTION_TOLERANCE: number = 10;

/** How far, in photo pixels, a dragged corner may be from where the mouse took it. */
const DRAG_TOLERANCE: number = 3;

const CROSSED_MESSAGE: string =
  'Os cantos estão cruzados. Arraste-os para formar um quadrilátero.';

/** How long a toast stays on screen before it goes away by itself, in ms. */
const TOAST_DURATION: number = 6_000;

/** Side of the loupe, and its distance above the mouse pointer, in screen pixels. */
const LOUPE_SIZE: number = 128;
const LOUPE_GAP: number = 32;

/** Opens the app, uploads the photos and continues to the Crop step. */
async function openCrop(page: Page, files: Fixture[]): Promise<void> {
  await openApp(page);
  await uploadImages(page, files);
  await clickContinue(page);
  await expect(page.getByTestId('corner-editor')).toBeVisible();
  await expect(page.getByTestId('step-1')).toHaveAttribute(
    'aria-current',
    'step',
  );
}

/** A point moved by `delta`, in the same unit as both. */
function offset(point: Point, delta: Point): Point {
  return { x: point.x + delta.x, y: point.y + delta.y };
}

/** The straight-line distance between two points, in their unit. */
function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
 * Presses the mouse on a corner handle, `grab` screen pixels away from its center (still on the
 * handle); returns where it was pressed, on the screen.
 */
async function pressCorner(
  page: Page,
  index: number,
  grab: Point = { x: 0, y: 0 },
): Promise<Point> {
  const start: Point = offset(await cornerOnScreen(page, index), grab);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
}

/**
 * Drags a corner with the mouse by an amount in photo pixels and releases it, holding the handle
 * `grab` screen pixels away from its center. Returns the corners the editor shows once the drag
 * is over.
 */
async function dragCorner(
  page: Page,
  index: number,
  delta: Point,
  grab: Point = { x: 0, y: 0 },
): Promise<Quad> {
  const scale: number = await editorScale(page);
  const start: Point = await pressCorner(page, index, grab);
  await page.mouse.move(start.x + delta.x * scale, start.y + delta.y * scale, {
    steps: 8,
  });
  await page.mouse.up();
  // The drag is over once the loupe and the highlight of the handle are gone
  await expect(page.getByTestId('loupe')).toHaveCount(0);
  await expect(page.getByTestId(`corner-${String(index)}`)).not.toHaveClass(
    /is-active/,
  );
  return editorCorners(page);
}

/**
 * Keeps the toasts on screen until the app dismisses them: the timer that takes a toast away
 * after `TOAST_DURATION` never runs out. A toast that goes away was then dismissed by the app,
 * however slow the machine is, and one that must be on screen is still there.
 */
async function keepToasts(page: Page): Promise<void> {
  await page.addInitScript((duration: number): void => {
    const original: typeof window.setTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ): number =>
      original(
        handler,
        // The longest delay a timer accepts, about 24 days
        timeout === duration ? 2 ** 31 - 1 : timeout,
        ...args,
      )) as typeof window.setTimeout;
  }, TOAST_DURATION);
}

/**
 * The point the loupe is placed around: the middle of its bottom edge, moved down by the gap. While
 * there is room above, this is where the pointer is.
 */
async function loupeAnchor(loupe: Locator): Promise<Point> {
  const box: { x: number; y: number; width: number; height: number } | null =
    await loupe.boundingBox();
  if (!box) throw new Error('The loupe is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height + LOUPE_GAP };
}

/** The "!" mark of a carousel tile. */
function alertMark(page: Page, index: number): Locator {
  return page.getByTestId(`doc-${String(index)}`).locator('.doc-tile-alert');
}

/** The image of a carousel tile, by its position from 0. */
function thumbnail(page: Page, index: number): Locator {
  return page.getByTestId(`doc-${String(index)}`).locator('img');
}

/** The toasts of one kind on screen. */
function toasts(page: Page, kind: 'error' | 'warning'): Locator {
  return page.locator(`[data-testid="toast"][data-kind="${kind}"]`);
}

/** The "Continue" button of the Crop step. */
function cropContinue(page: Page): Locator {
  return page.getByTestId('crop');
}

/** Waits until the thumbnail of a tile shows its crop, and returns its data URL. */
async function settledThumbnail(page: Page, index: number): Promise<string> {
  const tile: Locator = page.getByTestId(`doc-${String(index)}`);
  await expect(thumbnail(page, index)).toHaveClass('is-preview');
  await expect(tile).not.toHaveAttribute('aria-busy', 'true');
  const src: string | null = await thumbnail(page, index).getAttribute('src');
  expect(src).toMatch(/^data:image\//);
  return src ?? '';
}

/**
 * Drags the top-left corner of the invoice past the top-right one, so the outline crosses itself.
 * Returns the amount it was dragged, in photo pixels.
 */
async function crossInvoiceCorners(page: Page): Promise<Point> {
  const before: Quad = await editorCorners(page);
  // To the right of the top-right corner, at the same height as before
  const delta: Point = { x: before[1].x - before[0].x + 250, y: 0 };
  const after: Quad = await dragCorner(page, 0, delta);
  expect(distance(after[0], offset(before[0], delta))).toBeLessThan(
    DRAG_TOLERANCE,
  );
  return delta;
}

test.describe('Crop step', (): void => {
  test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
    await keepToasts(page);
  });

  test('places the corners of invoice.jpg on the edges of the sheet', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);

    const editor: Locator = page.getByTestId('corner-editor');
    await expect(editor).toHaveAttribute('viewBox', '0 0 1600 1200');
    const corners: Quad = await editorCorners(page);
    expect(
      maxCornerError(corners, FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);

    await expect(page.getByTestId('detect-status')).toHaveText(
      'Mova os cantos para enquadrar a área da imagem que deseja escanear',
    );
    await expect(cropContinue(page)).toBeEnabled();
    await expect(alertMark(page, 0)).toHaveCount(0);
    await expect(page.getByTestId('loupe')).toHaveCount(0);
  });

  test('places the corners of receipt.jpg on the edges of the narrow sheet', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['receipt.jpg']);

    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 1400 1300',
    );
    const corners: Quad = await editorCorners(page);
    expect(
      maxCornerError(corners, FIXTURE_CORNERS['receipt.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);
    await expect(cropContinue(page)).toBeEnabled();
  });

  test('moves a dragged corner by the dragged amount and leaves the others in place', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const before: Quad = await editorCorners(page);

    const delta: Point = { x: 120, y: 90 };
    const after: Quad = await dragCorner(page, 0, delta);

    expect(distance(after[0], offset(before[0], delta))).toBeLessThan(
      DRAG_TOLERANCE,
    );
    for (const i of [1, 2, 3]) {
      expect(after[i]).toEqual(before[i]);
    }
    await expect(cropContinue(page)).toBeEnabled();

    // The bottom-right corner, dragged up and to the left, held 12 screen pixels right of its
    // center: it moves by the dragged amount, and does not jump to the pointer
    const delta2: Point = { x: -150, y: -60 };
    const after2: Quad = await dragCorner(page, 2, delta2, { x: 12, y: 0 });
    expect(distance(after2[2], offset(before[2], delta2))).toBeLessThan(
      DRAG_TOLERANCE,
    );
    expect(after2[0]).toEqual(after[0]);
    expect(after2[1]).toEqual(before[1]);
    expect(after2[3]).toEqual(before[3]);
  });

  test('keeps a corner dragged past the edge of the photo inside it', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const before: Quad = await editorCorners(page);

    // Far beyond the top-left corner of the 1600 x 1200 photo
    const after: Quad = await dragCorner(page, 0, {
      x: -before[0].x - 400,
      y: -before[0].y - 400,
    });

    expect(after[0]).toEqual({ x: 0, y: 0 });
    expect(after.slice(1)).toEqual(before.slice(1));
    await expect(cropContinue(page)).toBeEnabled();

    // Far beyond the bottom-right corner: it stops at the width and the height of the photo
    const after2: Quad = await dragCorner(page, 2, {
      x: 1600 - before[2].x + 400,
      y: 1200 - before[2].y + 400,
    });

    expect(after2[2]).toEqual({ x: 1600, y: 1200 });
    expect(after2[0]).toEqual({ x: 0, y: 0 });
    await expect(cropContinue(page)).toBeEnabled();
  });

  test('shows the loupe only while a corner is dragged', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const loupe: Locator = page.getByTestId('loupe');
    await expect(loupe).toHaveCount(0);

    const start: Point = await pressCorner(page, 2);
    await expect(loupe).toBeVisible();
    const box: { width: number; height: number } | null =
      await loupe.boundingBox();
    expect(box).toEqual(
      expect.objectContaining({ width: LOUPE_SIZE, height: LOUPE_SIZE }),
    );
    await expect(page.getByTestId('corner-2')).toHaveClass(/is-active/);
    await expect(page.locator('.corner.is-active')).toHaveCount(1);
    // Centered above the pointer, with a gap so the pointer does not cover it
    await expect
      .poll(async (): Promise<number> =>
        distance(await loupeAnchor(loupe), start),
      )
      .toBeLessThan(2);

    // The loupe follows the pointer
    const moved: Point = { x: start.x - 60, y: start.y - 80 };
    await page.mouse.move(moved.x, moved.y, { steps: 4 });
    await expect(loupe).toBeVisible();
    await expect
      .poll(async (): Promise<number> =>
        distance(await loupeAnchor(loupe), moved),
      )
      .toBeLessThan(2);

    await page.mouse.up();
    await expect(loupe).toHaveCount(0);
    await expect(page.getByTestId('corner-2')).not.toHaveClass(/is-active/);
  });

  test('redoes the thumbnail of the dragged document in the carousel', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const before: string = await settledThumbnail(page, 0);

    await dragCorner(page, 1, { x: 150, y: 120 });

    await expect
      .poll(async (): Promise<string | null> =>
        thumbnail(page, 0).getAttribute('src'),
      )
      .not.toBe(before);
    const after: string = await settledThumbnail(page, 0);
    expect(after).not.toBe(before);
  });

  test('"Detect automatically" puts the dragged corners back on the edges', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const detected: Quad = await editorCorners(page);
    await dragCorner(page, 0, { x: 200, y: 150 });
    const dragged: Quad = await dragCorner(page, 3, { x: 100, y: -120 });
    expect(maxCornerError(dragged, detected)).toBeGreaterThan(150);

    await page
      .getByRole('button', { name: 'Detectar automaticamente' })
      .click();

    await expect
      .poll(async (): Promise<number> =>
        maxCornerError(await editorCorners(page), detected),
      )
      .toBeLessThan(1);
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);
  });

  for (const shortcut of ['Control+z', 'Meta+z']) {
    test(`${shortcut} puts the dragged corners back on the edges`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await openCrop(page, ['receipt.jpg']);
      const detected: Quad = await editorCorners(page);
      const dragged: Quad = await dragCorner(page, 2, { x: -200, y: -150 });
      expect(maxCornerError(dragged, detected)).toBeGreaterThan(200);

      await page.keyboard.press(shortcut);

      await expect
        .poll(async (): Promise<number> =>
          maxCornerError(await editorCorners(page), detected),
        )
        .toBeLessThan(1);
      expect(
        maxCornerError(
          await editorCorners(page),
          FIXTURE_CORNERS['receipt.jpg'],
        ),
      ).toBeLessThan(DETECTION_TOLERANCE);
    });
  }

  test('crossed corners show a warning, mark the tile and block Continue until fixed', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const tile: Locator = page.getByTestId('doc-0');
    await expect(tile).toHaveAccessibleName('Documento 1');

    const delta: Point = await crossInvoiceCorners(page);

    const error: Locator = toasts(page, 'error');
    await expect(error).toHaveCount(1);
    await expect(error).toHaveText(CROSSED_MESSAGE);
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(alertMark(page, 0)).toHaveText('!');
    await expect(tile).toHaveAccessibleName(
      'Documento 1, precisa de ajuste no recorte',
    );
    await expect(cropContinue(page)).toBeDisabled();
    // Neither can the top bar skip ahead
    await expect(page.getByTestId('step-2')).toBeDisabled();
    await expect(page.getByTestId('step-3')).toBeDisabled();

    // Dragging the corner back where it was fixes the crop
    await dragCorner(page, 0, { x: -delta.x, y: -delta.y });

    // The toasts do not go away by themselves here: the fix took it away
    await expect(error).toHaveCount(0);
    await expect(alertMark(page, 0)).toHaveCount(0);
    await expect(tile).toHaveAccessibleName('Documento 1');
    await expect(cropContinue(page)).toBeEnabled();
    await expect(page.getByTestId('step-2')).toBeEnabled();

    await cropContinue(page).click();
    await expect(page.getByTestId('step-2')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  test('shows the crossed warning again on each drag that leaves the corners crossed', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    await crossInvoiceCorners(page);
    const error: Locator = toasts(page, 'error');
    await expect(error).toHaveCount(1);

    await page.getByRole('button', { name: 'Fechar aviso' }).click();
    await expect(error).toHaveCount(0);

    // Still crossed after this drag
    await dragCorner(page, 0, { x: 30, y: 30 });
    await expect(error).toHaveCount(1);
    await expect(error).toHaveText(CROSSED_MESSAGE);
    await expect(cropContinue(page)).toBeDisabled();
  });

  test('"Detect automatically" fixes crossed corners', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const detected: Quad = await editorCorners(page);
    await crossInvoiceCorners(page);
    await expect(toasts(page, 'error')).toHaveCount(1);
    await expect(cropContinue(page)).toBeDisabled();

    await page.getByTestId('auto-detect').click();

    // The detection runs in the background
    await expect
      .poll(async (): Promise<number> =>
        maxCornerError(await editorCorners(page), detected),
      )
      .toBeLessThan(1);
    await expect(toasts(page, 'error')).toHaveCount(0);
    await expect(alertMark(page, 0)).toHaveCount(0);
    await expect(cropContinue(page)).toBeEnabled();
  });

  test('flags a crossed document while another one is on display', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg', 'receipt.jpg']);
    const detected: Quad = await editorCorners(page);
    await crossInvoiceCorners(page);
    await expect(toasts(page, 'error')).toHaveText(CROSSED_MESSAGE);

    await page.getByTestId('doc-1').click();
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 1400 1300',
    );

    // The receipt is fine: the error goes, and a warning points at the invoice
    await expect(toasts(page, 'error')).toHaveCount(0);
    const warning: Locator = toasts(page, 'warning');
    await expect(warning).toHaveText(
      '1 documento precisa de ajuste no recorte. Ele está marcado com ! na lista.',
    );
    await expect(alertMark(page, 0)).toHaveText('!');
    await expect(alertMark(page, 1)).toHaveCount(0);
    await expect(cropContinue(page)).toBeDisabled();

    // Opening the invoice again shows the crossed error
    await page.getByTestId('doc-0').click();
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 1600 1200',
    );
    await expect(toasts(page, 'error')).toHaveText(CROSSED_MESSAGE);
    await expect(cropContinue(page)).toBeDisabled();

    await page.keyboard.press('Control+z');
    // The detection runs in the background
    await expect
      .poll(async (): Promise<number> =>
        maxCornerError(await editorCorners(page), detected),
      )
      .toBeLessThan(1);
    await expect(toasts(page, 'error')).toHaveCount(0);
    await expect(warning).toHaveCount(0);
    await expect(alertMark(page, 0)).toHaveCount(0);
    await expect(cropContinue(page)).toBeEnabled();
  });

  test('shows the image and corners of the document selected in the carousel', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg', 'receipt.jpg']);
    const editor: Locator = page.getByTestId('corner-editor');
    const image: Locator = editor.locator('image');
    const first: Locator = page.getByTestId('doc-0');
    const second: Locator = page.getByTestId('doc-1');

    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(second).not.toHaveAttribute('aria-current', 'true');
    await expect(editor).toHaveAttribute('viewBox', '0 0 1600 1200');
    await expect(image).toHaveAttribute('width', '1600');
    const invoiceUrl: string | null = await image.getAttribute('href');
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);

    await second.click();
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(first).not.toHaveAttribute('aria-current', 'true');
    await expect(editor).toHaveAttribute('viewBox', '0 0 1400 1300');
    await expect(image).toHaveAttribute('height', '1300');
    await expect(image).not.toHaveAttribute('href', invoiceUrl ?? '');
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['receipt.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);

    // A drag only changes the document on display
    const receiptBefore: Quad = await editorCorners(page);
    const receiptDragged: Quad = await dragCorner(page, 1, {
      x: -100,
      y: 80,
    });
    expect(distance(receiptDragged[1], receiptBefore[1])).toBeGreaterThan(100);

    await first.click();
    await expect(editor).toHaveAttribute('viewBox', '0 0 1600 1200');
    await expect(image).toHaveAttribute('href', invoiceUrl ?? '');
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(DETECTION_TOLERANCE);

    // A drag of the invoice, then "Detect automatically" on the receipt: only the receipt goes
    // back on its edges
    const invoiceDragged: Quad = await dragCorner(page, 3, { x: 90, y: -70 });
    expect(
      maxCornerError(invoiceDragged, FIXTURE_CORNERS['invoice.jpg']),
    ).toBeGreaterThan(100);

    await second.click();
    await expect(editor).toHaveAttribute('viewBox', '0 0 1400 1300');
    expect(await editorCorners(page)).toEqual(receiptDragged);

    await page.getByTestId('auto-detect').click();
    await expect
      .poll(async (): Promise<number> =>
        maxCornerError(await editorCorners(page), receiptBefore),
      )
      .toBeLessThan(1);

    await first.click();
    await expect(editor).toHaveAttribute('viewBox', '0 0 1600 1200');
    expect(await editorCorners(page)).toEqual(invoiceDragged);
  });

  test('Back returns to Upload keeping the documents and their corners', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg', 'receipt.jpg']);
    const dragged: Quad = await dragCorner(page, 0, { x: 80, y: 60 });

    await page.getByRole('button', { name: 'Voltar', exact: true }).click();

    await expect(page.getByTestId('step-0')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('corner-editor')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Você enviou 2 imagens' }),
    ).toBeVisible();
    await expect(documentTiles(page)).toHaveCount(2);
    await expect(page.getByTestId('upload-continue')).toBeEnabled();

    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toHaveAttribute(
      'viewBox',
      '0 0 1600 1200',
    );
    expect(await editorCorners(page)).toEqual(dragged);
  });
});
