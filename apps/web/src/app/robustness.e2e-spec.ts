import {
  type BrowserContext,
  type CDPSession,
  expect,
  type JSHandle,
  type Locator,
  type Page,
  type Request,
  type Route,
  test,
  type WebSocket,
} from '@playwright/test';

import {
  clickContinue,
  cornerOnScreen,
  documentTiles,
  type DownloadedFile,
  editorCorners,
  FIXTURE_CORNERS,
  fixturePath,
  maxCornerError,
  openApp,
  type Point,
  type Quad,
  readImage,
  readPdf,
  uploadImages,
} from '@/test-support/e2e/app';
import {
  choose,
  exportFile,
  openAdjust,
  openCrop,
  resultSize,
} from '@/test-support/e2e/result';
import { dataTransferWith, fixtureFile } from '@/test-support/e2e/upload';

/** Where the app is served: the only origin it may talk to. */
const APP_ORIGIN: string = 'http://localhost:4173';

/** How far, in photo pixels, a detected corner may be from where the sheet really is. */
const DETECTION_TOLERANCE: number = 10;

/** How far, in photo pixels, a corner put back on the image corners may be from them. */
const IMAGE_CORNER_TOLERANCE: number = 3;

const DETECTOR_ERROR: string = 'Não foi possível carregar o detector de bordas';

/** The corners of the whole `blank.png` photo, 800 × 600, clockwise from the top left. */
const BLANK_IMAGE_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 800, y: 0 },
  { x: 800, y: 600 },
  { x: 0, y: 600 },
];

/** Whether the page canceled each event of a file drag, so the browser skips its default action. */
interface DragOutcome {
  dragover: boolean;
  drop: boolean;
}

/**
 * Drags an image file over an element and drops it there with synthetic events, as `dropFiles`
 * does, and tells which events the page canceled. A drop whose `dragover` and `drop` are not
 * canceled is handled by the browser itself, which opens the file in the tab: the page, and the
 * documents that only live in its memory, are gone.
 */
async function dragOutcome(page: Page, target: Locator): Promise<DragOutcome> {
  const dataTransfer: JSHandle<DataTransfer> = await dataTransferWith(page, [
    await fixtureFile('blank.png'),
  ]);
  return target.evaluate(
    (element: Element, transfer: DataTransfer): DragOutcome => {
      const fire = (type: string): boolean =>
        // dispatchEvent is false when a listener called preventDefault
        !element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer: transfer,
          }),
        );
      fire('dragenter');
      return { dragover: fire('dragover'), drop: fire('drop') };
    },
    dataTransfer,
  );
}

/**
 * The center of an element on the screen, in CSS pixels of the page.
 *
 * @throws When the element is not rendered.
 */
async function centerOf(target: Locator): Promise<Point> {
  const box: { x: number; y: number; width: number; height: number } | null =
    await target.boundingBox();
  if (!box) throw new Error('The element is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drops a fixture photo on a point of the screen through the DevTools protocol, the way the
 * browser delivers a file dragged from the desktop: the page only gets the `drop` event if it
 * accepted the drag in `dragover`.
 */
async function systemDrop(
  page: Page,
  point: Point,
  file: 'invoice.jpg' | 'blank.png',
): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const data: {
    items: { mimeType: string; data: string }[];
    files: string[];
    dragOperationsMask: number;
  } = {
    items: [],
    files: [fixturePath(file)],
    // Copy, link and move, as a file manager offers
    dragOperationsMask: 1 | 2 | 16,
  };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', {
      type,
      x: point.x,
      y: point.y,
      data,
    });
  }
  await cdp.detach();
}

/** Starts counting the `drop` events that reach the page, whatever their target. */
async function countDrops(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const counter: { drops: number } = { drops: 0 };
    (globalThis as unknown as { dropCounter: { drops: number } }).dropCounter =
      counter;
    window.addEventListener(
      'drop',
      (): void => {
        counter.drops++;
      },
      true,
    );
  });
}

/** How many `drop` events reached the page since `countDrops`. */
async function dropsSeen(page: Page): Promise<number> {
  return page.evaluate(
    (): number =>
      (globalThis as unknown as { dropCounter: { drops: number } }).dropCounter
        .drops,
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
 * Drags a corner handle with the mouse by an amount in photo pixels, releases it and waits until
 * the loupe is gone.
 */
async function dragCorner(
  page: Page,
  index: number,
  delta: Point,
): Promise<void> {
  const scale: number = await editorScale(page);
  const start: Point = await cornerOnScreen(page, index);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x * scale, start.y + delta.y * scale, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(page.getByTestId('loupe')).toHaveCount(0);
}

/** The button named exactly "Continuar" (Continue), which moves to the next step. */
function continueButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Continuar', exact: true });
}

test.describe('Files dropped outside the drop zones', () => {
  test('a file dropped on the top bar, the stage or the panel is not opened by the browser', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    test.fail();
    // Known bug: only the Upload screen, the carousel and the import overlay call preventDefault
    // on dragover and drop. Nothing does at the window level, so in Chrome an image dropped on
    // the top bar, or on the stage or panel of Crop, Adjust or Export, is opened in the tab by
    // the browser: the page navigates to file:///… and every document of the scan is lost.
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    const outcomes: Record<string, DragOutcome> = {};
    // The whole Upload screen is a drop zone, but the top bar is not part of it
    outcomes['Upload: top bar'] = await dragOutcome(
      page,
      page.locator('.topbar'),
    );
    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('corner-editor')).toBeVisible();

    // Control: the carousel is a drop zone, so it cancels both events
    expect(await dragOutcome(page, page.locator('.doc-carousel'))).toEqual({
      dragover: true,
      drop: true,
    });
    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });

    outcomes['Crop: top bar'] = await dragOutcome(
      page,
      page.locator('.topbar'),
    );
    outcomes['Crop: stage'] = await dragOutcome(
      page,
      page.getByTestId('corner-editor'),
    );
    outcomes['Crop: panel'] = await dragOutcome(page, page.locator('.panel'));

    await clickContinue(page);
    await resultSize(page);
    outcomes['Adjust: stage'] = await dragOutcome(
      page,
      page.getByTestId('result'),
    );
    outcomes['Adjust: panel'] = await dragOutcome(page, page.locator('.panel'));

    await page.getByTestId('continue').click();
    await expect(page.getByTestId('download')).toBeEnabled();
    outcomes['Export: stage'] = await dragOutcome(
      page,
      page.getByTestId('result'),
    );
    outcomes['Export: panel'] = await dragOutcome(page, page.locator('.panel'));

    const prevented: DragOutcome = { dragover: true, drop: true };
    expect(outcomes).toEqual({
      'Upload: top bar': prevented,
      'Crop: top bar': prevented,
      'Crop: stage': prevented,
      'Crop: panel': prevented,
      'Adjust: stage': prevented,
      'Adjust: panel': prevented,
      'Export: stage': prevented,
      'Export: panel': prevented,
    });
  });

  test('a file dropped from the system on the top bar or the Crop stage keeps the scan', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    await countDrops(page);
    const navigations: string[] = [];
    page.on('framenavigated', (frame: { url(): string }): void => {
      navigations.push(frame.url());
    });

    // Control: the same drop on the carousel reaches the page and imports the photo
    await systemDrop(
      page,
      await centerOf(page.locator('.doc-carousel')),
      'blank.png',
    );
    await expect(documentTiles(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-progress')).toBeHidden({
      timeout: 60_000,
    });
    expect(await dropsSeen(page)).toBe(1);

    await systemDrop(
      page,
      await centerOf(page.locator('.topbar')),
      'blank.png',
    );
    await systemDrop(
      page,
      await centerOf(page.getByTestId('corner-editor')),
      'blank.png',
    );

    // Nothing accepted these drags, so the page never got their drop and imported nothing
    expect(await dropsSeen(page)).toBe(1);
    expect(navigations).toEqual([]);
    expect(page.url()).toBe(`${APP_ORIGIN}/`);
    await expect(documentTiles(page)).toHaveCount(2);
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.getByTestId('corner-editor')).toBeVisible();
  });
});

test.describe('Edge detector that fails to load', () => {
  // opencv.js comes straight from the server, not from a service worker cache the route misses
  test.use({ serviceWorkers: 'block' });

  test('imports the photo whole, says so in Crop, and detects once the detector loads', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    const blocked: string[] = [];
    const blockOpenCv = async (route: Route): Promise<void> => {
      blocked.push(route.request().url());
      await route.fulfill({ status: 404, body: 'Not found' });
    };
    await page.route('**/opencv.js', blockOpenCv);

    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);
    expect(blocked).toEqual([`${APP_ORIGIN}/opencv.js`]);
    // The document is there, with the whole photo
    await expect(documentTiles(page)).toHaveCount(1);
    await expect
      .poll(async (): Promise<string> =>
        page
          .getByTestId('doc-0')
          .locator('img')
          .evaluate(
            (img: Element): string =>
              `${String((img as HTMLImageElement).naturalWidth)}x${String((img as HTMLImageElement).naturalHeight)}`,
          ),
      )
      .toBe('1600x1200');

    await page.getByTestId('upload-continue').click();
    await expect(page.getByTestId('step-1')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.locator('.stage-status')).toHaveText(DETECTOR_ERROR);
    await expect(
      page.getByRole('alert').filter({ hasText: DETECTOR_ERROR }),
    ).toBeVisible();
    await expect(page.getByTestId('corner-editor')).toHaveCount(0);
    await expect(continueButton(page)).toBeDisabled();

    await page.unroute('**/opencv.js', blockOpenCv);
    await page
      .getByRole('button', { name: 'Detectar automaticamente' })
      .click();

    await expect(page.getByTestId('corner-editor')).toBeVisible({
      timeout: 60_000,
    });
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThanOrEqual(DETECTION_TOLERANCE);
    await expect(page.locator('.stage-status')).toHaveCount(0);
    await expect(continueButton(page)).toBeEnabled();
    expect(blocked).toHaveLength(1);
  });
});

/** A request the page or its service worker made. */
interface RecordedRequest {
  url: string;
  method: string;
  body: Buffer | null;
  fromServiceWorker: boolean;
}

test.describe('Privacy', () => {
  test('a whole scan sends nothing anywhere: only GETs to the app itself, without bodies', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }): Promise<void> => {
    const requests: Map<Request, RecordedRequest> = new Map();
    const record = (request: Request): void => {
      requests.set(request, {
        url: request.url(),
        method: request.method(),
        body: request.postDataBuffer(),
        fromServiceWorker: request.serviceWorker() !== null,
      });
    };
    page.on('request', record);
    context.on('request', record);
    const sockets: string[] = [];
    page.on('websocket', (socket: WebSocket): void => {
      sockets.push(socket.url());
    });

    await openAdjust(page, ['invoice.jpg']);
    await choose(page, 'Preto e branco');
    await resultSize(page);
    await page.getByTestId('continue').click();
    await expect(page.getByTestId('download')).toBeEnabled();

    const pdf: DownloadedFile = await exportFile(page);
    expect((await readPdf(pdf.data)).pageCount).toBe(1);
    await choose(page, 'PNG');
    const png: DownloadedFile = await exportFile(page);
    expect(readImage(png.data).format).toBe('png');

    // The recorder sees the requests of the service worker too: it stores the app files, opencv.js
    // included, in the background
    await expect
      .poll((): boolean =>
        [...requests.values()].some(
          (r: RecordedRequest): boolean =>
            r.fromServiceWorker && r.url === `${APP_ORIGIN}/opencv.js`,
        ),
      )
      .toBe(true);
    const recorded: RecordedRequest[] = [...requests.values()];
    expect(
      recorded.some(
        (r: RecordedRequest): boolean =>
          !r.fromServiceWorker && r.url === `${APP_ORIGIN}/opencv.js`,
      ),
    ).toBe(true);

    const leaving: string[] = recorded
      .filter((r: RecordedRequest): boolean => {
        if (r.url.startsWith('data:')) return false;
        return new URL(r.url).origin !== APP_ORIGIN;
      })
      .map((r: RecordedRequest): string => r.url);
    expect(leaving).toEqual([]);
    const writes: string[] = recorded
      .filter((r: RecordedRequest): boolean => r.method !== 'GET')
      .map((r: RecordedRequest): string => `${r.method} ${r.url}`);
    expect(writes).toEqual([]);
    const withBody: string[] = recorded
      .filter((r: RecordedRequest): boolean => (r.body?.length ?? 0) > 0)
      .map((r: RecordedRequest): string => r.url);
    expect(withBody).toEqual([]);
    expect(sockets).toEqual([]);
  });
});

test.describe('Detection on a photo without a document', () => {
  test('puts the corners back on the corners of the image after a drag', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['blank.png']);
    expect(
      maxCornerError(await editorCorners(page), BLANK_IMAGE_CORNERS),
    ).toBeLessThanOrEqual(IMAGE_CORNER_TOLERANCE);

    await dragCorner(page, 0, { x: 200, y: 150 });
    const dragged: Quad = await editorCorners(page);
    expect(dragged[0].x).toBeGreaterThan(150);
    expect(dragged[0].y).toBeGreaterThan(100);

    await page
      .getByRole('button', { name: 'Detectar automaticamente' })
      .click();
    await expect
      .poll(async (): Promise<number> =>
        maxCornerError(await editorCorners(page), BLANK_IMAGE_CORNERS),
      )
      .toBeLessThanOrEqual(IMAGE_CORNER_TOLERANCE);
  });
});
