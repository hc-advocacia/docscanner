import {
  type CDPSession,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

import {
  cornerOnScreen,
  documentTiles,
  editorCorners,
  openApp,
  type Point,
  type Quad,
  uploadImages,
} from '@/test-support/e2e/app';
import { openCrop } from '@/test-support/e2e/result';
import { uploadedPhotos } from '@/test-support/e2e/upload';

/*
 * Touch and keyboard interactions the mouse tests do not reach: reordering the carousel with a
 * finger (hold, then drag), swiping it without reordering, dragging a crop corner with a finger,
 * and where the keyboard focus goes after a document is removed with its remove button.
 *
 * The touches go through the DevTools protocol (`Input.dispatchTouchEvent`), as real touches of
 * the screen: Chrome turns them into pointer events of type `touch` and, when the page does not
 * stop it, into a scroll of what is under the finger.
 */

/** With touch, how long to hold a tile, in ms, before it can be dragged (`useSortable`). */
const TOUCH_HOLD_MS: number = 300;

/** How far, in photo pixels, a dragged corner may be from where the finger took it. */
const DRAG_TOLERANCE: number = 3;

/** How long the focus has to land somewhere after a removal, in ms. */
const FOCUS_WAIT: { timeout: number } = { timeout: 5_000 };

/** A phone held upright, with a touch screen. */
const PHONE: {
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
} = {
  viewport: { width: 440, height: 956 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
};

/** A touch screen, driven through the DevTools protocol. */
interface Finger {
  down(point: Point): Promise<void>;
  /** Slides the finger to a point, in `steps` small moves, without waiting between them. */
  move(to: Point, steps: number): Promise<void>;
  up(): Promise<void>;
}

/** A finger on the page: one touch point at a time. */
async function fingerOn(page: Page): Promise<Finger> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const at: { point: Point } = { point: { x: 0, y: 0 } };
  return {
    down: async (point: Point): Promise<void> => {
      at.point = point;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: point.x, y: point.y }],
      });
    },
    move: async (to: Point, steps: number): Promise<void> => {
      const from: Point = at.point;
      for (let i: number = 1; i <= steps; i++) {
        const point: Point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        at.point = point;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: point.x, y: point.y }],
        });
      }
    },
    up: async (): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    },
  };
}

/** Where to touch a tile: its center, a bit low to stay clear of the remove button. */
async function tileCenter(page: Page, index: number): Promise<Point> {
  const box: { x: number; y: number; width: number; height: number } | null =
    await page.getByTestId(`doc-${String(index)}`).boundingBox();
  if (!box) throw new Error(`Tile ${String(index)} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
}

/** The numbers drawn on the tiles, in carousel order. */
async function tileNumbers(page: Page): Promise<string[]> {
  return page.locator('.doc-tile-n').allTextContents();
}

/** What the init script of {@link recordDrags} saw in the page. */
interface DragRecord {
  /** When the last touch pointer went down, in ms of `performance.now()`. */
  touchDownAt: number | null;
  /** When a tile last started being dragged (got `is-dragging`), in ms of `performance.now()`. */
  dragStartAt: number | null;
  /** How many times a tile started being dragged. */
  drags: number;
}

/** Records, from the moment the page loads, when touches go down and when tiles start a drag. */
async function recordDrags(page: Page): Promise<void> {
  await page.addInitScript((): void => {
    const record: DragRecord = {
      touchDownAt: null,
      dragStartAt: null,
      drags: 0,
    };
    (window as unknown as { dragRecord: DragRecord }).dragRecord = record;
    window.addEventListener(
      'pointerdown',
      (e: PointerEvent): void => {
        if (e.pointerType === 'touch') record.touchDownAt = performance.now();
      },
      { capture: true },
    );
    new MutationObserver((mutations: MutationRecord[]): void => {
      for (const mutation of mutations) {
        const target: Element = mutation.target as Element;
        const was: boolean = (mutation.oldValue ?? '')
          .split(' ')
          .includes('is-dragging');
        if (target.classList.contains('is-dragging') && !was) {
          record.dragStartAt = performance.now();
          record.drags++;
        }
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
  });
}

/** What {@link recordDrags} has seen in the page so far. */
async function dragRecord(page: Page): Promise<DragRecord> {
  return page.evaluate(
    (): DragRecord =>
      (window as unknown as { dragRecord: DragRecord }).dragRecord,
  );
}

/** Screen pixels per photo pixel in the crop editor. */
async function editorScale(page: Page): Promise<number> {
  return page.getByTestId('corner-editor').evaluate((svg: Element): number => {
    const ctm: DOMMatrix | null = (svg as SVGSVGElement).getScreenCTM();
    if (!ctm) throw new Error('The corner editor has no screen transform');
    return ctm.a;
  });
}

/**
 * Describes the focused element by its test id, or its tag name without one, or `body` when
 * nothing has the focus.
 */
async function focused(page: Page): Promise<string> {
  return page.evaluate((): string => {
    const el: Element | null = document.activeElement;
    if (!el || el === document.body) return 'body';
    const testId: string | null = el.getAttribute('data-testid');
    return testId ?? el.tagName.toLowerCase();
  });
}

/** Whether the focused element is inside a document carousel. */
async function focusInCarousel(page: Page): Promise<boolean> {
  return page.evaluate(
    (): boolean => !!document.activeElement?.closest('.doc-carousel'),
  );
}

test.describe('Touch, on a phone', (): void => {
  test.use(PHONE);

  test('holding a tile, then dragging it past the next one, moves it there', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await recordDrags(page);
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'receipt', 'blank']);
    const dragged: Locator = page.locator('.doc-item.is-dragging');
    const carousel: Locator = page.locator('.doc-carousel.is-large');
    const start: Point = await tileCenter(page, 0);
    const next: Point = await tileCenter(page, 1);
    const finger: Finger = await fingerOn(page);

    // Held still: the drag starts by itself once the hold delay is over
    await finger.down(start);
    await expect(dragged).toHaveCount(1);
    await expect(dragged).toHaveAttribute('data-sortable', '0');
    await expect(carousel).toHaveClass(/is-sorting/);
    const held: DragRecord = await dragRecord(page);
    if (held.touchDownAt === null || held.dragStartAt === null)
      throw new Error('The touch or the drag was not recorded');
    expect(held.dragStartAt - held.touchDownAt).toBeGreaterThanOrEqual(
      TOUCH_HOLD_MS - 5,
    );

    // Past the center of the next tile, in small steps: the next tile makes room
    await finger.move({ x: next.x + 20, y: start.y }, 16);
    await expect(page.locator('[data-sortable="1"]')).toHaveAttribute(
      'style',
      /translateX\(-/,
    );
    await finger.up();

    await expect(dragged).toHaveCount(0);
    await expect(carousel).not.toHaveClass(/is-sorting/);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['receipt', 'invoice', 'blank']);
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
    await expect(page.getByTestId('remove-1')).toHaveAccessibleName(
      'Remover documento 2',
    );
  });

  test('a quick swipe over the tiles scrolls the carousel and does not reorder', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await recordDrags(page);
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);
    const carousel: Locator = page.locator('.doc-carousel.is-large');
    await expect
      .poll(async (): Promise<number> =>
        carousel.evaluate((el: Element): number => el.scrollLeft),
      )
      .toBe(0);
    const start: Point = await tileCenter(page, 1);
    const finger: Finger = await fingerOn(page);

    // To the left, at once: no time to hold
    await finger.down(start);
    await finger.move({ x: start.x - 200, y: start.y }, 20);
    await finger.up();

    await expect
      .poll(async (): Promise<number> =>
        carousel.evaluate((el: Element): number => el.scrollLeft),
      )
      .toBeGreaterThan(100);
    expect((await dragRecord(page)).drags).toBe(0);
    await expect(page.locator('.doc-item.is-dragging')).toHaveCount(0);
    await expect(carousel).not.toHaveClass(/is-sorting/);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'receipt', 'blank']);
    expect(await tileNumbers(page)).toEqual(['1', '2', '3']);
    // The page itself does not scroll sideways
    expect(await page.evaluate((): number => window.scrollX)).toBe(0);
  });

  test('dragging a crop corner with a finger moves it, with the loupe shown only while touching', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openCrop(page, ['invoice.jpg']);
    const loupe: Locator = page.getByTestId('loupe');
    const handle: Locator = page.getByTestId('corner-0');
    const before: Quad = await editorCorners(page);
    const scale: number = await editorScale(page);
    const start: Point = await cornerOnScreen(page, 0);
    const delta: Point = { x: -20, y: 24 };
    const finger: Finger = await fingerOn(page);

    await finger.down(start);
    await expect(loupe).toBeVisible();
    await expect(handle).toHaveClass(/is-active/);

    await finger.move({ x: start.x + delta.x, y: start.y + delta.y }, 10);
    await expect(loupe).toBeVisible();
    await expect(handle).toHaveClass(/is-active/);
    await expect
      .poll(async (): Promise<number> => (await editorCorners(page))[0].x)
      .toBeCloseTo(before[0].x + delta.x / scale, -1);

    await finger.up();
    await expect(loupe).toHaveCount(0);
    await expect(handle).not.toHaveClass(/is-active/);

    const after: Quad = await editorCorners(page);
    expect(
      Math.abs(after[0].x - (before[0].x + delta.x / scale)),
    ).toBeLessThanOrEqual(DRAG_TOLERANCE);
    expect(
      Math.abs(after[0].y - (before[0].y + delta.y / scale)),
    ).toBeLessThanOrEqual(DRAG_TOLERANCE);
    // Only the dragged corner moved
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

test.describe('Keyboard focus after removing a document', (): void => {
  test('removing a document with Enter on its remove button keeps the focus in the carousel', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Known bug: the focused remove button is unmounted with its document and nothing takes the
    // focus back, so document.activeElement becomes <body> and the keyboard user is lost
    test.fail();
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg', 'blank.png']);

    await page.getByTestId('remove-1').focus();
    await expect(page.getByTestId('remove-1')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(documentTiles(page)).toHaveCount(2);
    await expect
      .poll(async (): Promise<string[]> => uploadedPhotos(page))
      .toEqual(['invoice', 'blank']);
    // On the next document (now at the same position), its remove button, or elsewhere in the
    // carousel, but never nowhere
    await expect
      .poll(async (): Promise<string> => focused(page), FOCUS_WAIT)
      .not.toBe('body');
    expect(await focusInCarousel(page)).toBe(true);
  });

  test('removing the only document with Enter moves the focus to the buttons of the empty Upload step', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Known bug: the carousel goes away with the focused remove button and the empty Upload step
    // takes no focus, so document.activeElement becomes <body>
    test.fail();
    await openApp(page);
    await uploadImages(page, ['invoice.jpg']);

    await page.getByTestId('remove-0').focus();
    await expect(page.getByTestId('remove-0')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(documentTiles(page)).toHaveCount(0);
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect
      .poll(async (): Promise<string> => focused(page), FOCUS_WAIT)
      .toMatch(/^upload-(camera|files)$/);
  });
});
