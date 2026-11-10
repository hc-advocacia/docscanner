import { expect, type Locator, type Page, test } from '@playwright/test';

import { type Fixture, openApp, uploadImages } from '@/test-support/e2e/app';
import { resultSize } from '@/test-support/e2e/result';

/*
 * Phone layout. Before its fix, the top bar of a 440 px wide iPhone needed 475 px: the page got
 * wider than the screen, so the phone zoomed out, the step numbers wrapped below their
 * connectors, the language picker was cut at the right edge and the add buttons of the carousel
 * went off screen. In landscape, the Upload step cut its content with no way to scroll.
 *
 * With `isMobile`, Chrome lays out a page wider than the screen in a wider layout viewport, as
 * phones do: `window.innerWidth` growing past the screen width is the sign of that regression.
 */

/** A phone screen, in CSS pixels. */
interface Screen {
  name: string;
  width: number;
  height: number;
}

/**
 * The language of the app and what the top bar shows in it. The app is fixed to Brazilian
 * Portuguese, whatever the browser language: the top bar has no language picker.
 */
interface Language {
  /** `<html lang>`. */
  lang: string;
  /** Names of the four steps. */
  steps: [string, string, string, string];
}

const PORTUGUESE: Language = {
  lang: 'pt-BR',
  steps: ['Enviar', 'Recortar', 'Ajustar', 'Exportar'],
};

const IPHONE_PRO_MAX: Screen = {
  name: 'iPhone 17 Pro Max',
  width: 440,
  height: 956,
};

/** Phones held upright, from the widest to the narrowest. */
const PORTRAIT: Screen[] = [
  IPHONE_PRO_MAX,
  { name: 'iPhone 17 Pro Max with the Safari bars', width: 440, height: 830 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'Android phone', width: 360, height: 740 },
];

/**
 * Widths where the top bar changes: narrow phones (only the step numbers), wide phones, and the
 * range from 521 to 760 px where the current step shows its name.
 */
const TOP_BAR_SCREENS: Screen[] = [
  { name: 'narrow phone', width: 360, height: 740 },
  IPHONE_PRO_MAX,
  { name: 'wide phone', width: 521, height: 900 },
  { name: 'small tablet', width: 760, height: 1024 },
];

/** Phones turned sideways: short screens where the Upload step must scroll. */
const LANDSCAPE: Screen[] = [
  { name: 'iPhone 17 Pro Max in landscape', width: 956, height: 440 },
  {
    name: 'iPhone 17 Pro Max in landscape with the Safari bars',
    width: 956,
    height: 390,
  },
];

const THREE_DOCUMENTS: Fixture[] = [
  'invoice.jpg',
  'receipt.jpg',
  'invoice.jpg',
];

/** Rounding of the layout, in CSS pixels. */
const TOLERANCE: number = 1;

/** The Playwright options that emulate a phone with this screen: touch, mobile layout, 3× DPR. */
function phone(screen: Screen): {
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
} {
  return {
    viewport: { width: screen.width, height: screen.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  };
}

/** Waits for the web fonts and two frames, so the layout and the viewport are final. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async (): Promise<void> => {
    await document.fonts.ready;
    await new Promise<void>((resolve: () => void): void => {
      requestAnimationFrame((): void => {
        requestAnimationFrame((): void => {
          resolve();
        });
      });
    });
  });
}

/** How wide the page is laid out and shown. */
interface PageWidth {
  /** Width of the whole document, scrolled parts included. */
  scrollWidth: number;
  /** Width of the layout viewport, which grows when the page is wider than the screen. */
  innerWidth: number;
  /** Zoom of the visual viewport, below 1 when the phone zooms out. */
  zoom: number;
  /** Left and right edges of the workspace under the top bar. */
  workspace: [number, number];
}

/** The page is exactly as wide as the screen: no zoom out, nothing past the right edge. */
async function expectPageFits(page: Page, screen: Screen): Promise<void> {
  await settle(page);
  const measured: PageWidth = await page.evaluate((): PageWidth => {
    const workspace: Element | null = document.querySelector('.workspace');
    if (!workspace) throw new Error('No workspace');
    const box: DOMRect = workspace.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      zoom: window.visualViewport?.scale ?? 1,
      workspace: [box.left, box.right],
    };
  });
  expect(measured, 'the page is as wide as the screen').toEqual({
    scrollWidth: screen.width,
    innerWidth: screen.width,
    zoom: 1,
    workspace: [0, screen.width],
  });
}

/** Edges of an element on the screen. */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where an element is on the screen, read in the page. */
async function boxOf(target: Locator): Promise<Box> {
  return target.evaluate((element: Element): Box => {
    const rect: DOMRect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

interface StepLayout {
  item: Box;
  button: Box;
  number: Box;
  /** Width and right margin of the connector before the step, 0 when it is hidden. */
  connector: number;
}

interface TopBarLayout {
  /** The content box of the bar: inside its padding. */
  content: Box;
  brand: Box;
  steps: Box;
  items: StepLayout[];
}

/**
 * Measures the top bar in the page: its content box, its two parts, and the item, button,
 * number and connector of each step.
 */
async function topBarLayout(page: Page): Promise<TopBarLayout> {
  return page.locator('.topbar').evaluate((bar: HTMLElement): TopBarLayout => {
    const measure = (element: Element | null): Box => {
      if (!element) throw new Error('Missing part of the top bar');
      const rect: DOMRect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    };
    const style: CSSStyleDeclaration = getComputedStyle(bar);
    const outer: Box = measure(bar);
    return {
      content: {
        left: outer.left + parseFloat(style.paddingLeft),
        right: outer.right - parseFloat(style.paddingRight),
        top: outer.top + parseFloat(style.paddingTop),
        bottom: outer.bottom - parseFloat(style.paddingBottom),
      },
      brand: measure(bar.querySelector('.brand')),
      steps: measure(bar.querySelector('.steps')),
      items: [...bar.querySelectorAll('.steps li')].map(
        (item: Element): StepLayout => {
          const before: CSSStyleDeclaration = getComputedStyle(
            item,
            '::before',
          );
          return {
            item: measure(item),
            button: measure(item.querySelector('.step')),
            number: measure(item.querySelector('.step-n')),
            connector:
              before.display === 'none' || before.content === 'none'
                ? 0
                : parseFloat(before.width) + parseFloat(before.marginRight),
          };
        },
      ),
    };
  });
}

/** The vertical center of a box, to tell whether parts of the top bar are on the same line. */
const middle = (box: Box): number => (box.top + box.bottom) / 2;

/** A length in CSS pixels with one decimal, for the messages of {@link topBarProblems}. */
const px = (value: number): string => value.toFixed(1);

/** What is wrong with the top bar: parts outside it, overlapping, or on more than one line. */
function topBarProblems(layout: TopBarLayout): string[] {
  const problems: string[] = [];
  const parts: [string, Box][] = [
    ['brand', layout.brand],
    ['steps', layout.steps],
  ];
  for (const [name, box] of parts) {
    if (
      box.left < layout.content.left - TOLERANCE ||
      box.right > layout.content.right + TOLERANCE
    ) {
      problems.push(
        `${name} spans ${px(box.left)}–${px(box.right)}, outside the bar (${px(layout.content.left)}–${px(layout.content.right)})`,
      );
    }
    if (Math.abs(middle(box) - middle(layout.steps)) > TOLERANCE) {
      problems.push(
        `${name} is centered at ${px(middle(box))}, the steps at ${px(middle(layout.steps))}`,
      );
    }
  }
  if (layout.brand.right > layout.steps.left + TOLERANCE)
    problems.push('the brand overlaps the steps');
  if (layout.items.length !== 4)
    problems.push(`${String(layout.items.length)} steps instead of 4`);
  layout.items.forEach((step: StepLayout, i: number): void => {
    const name: string = `step ${String(i + 1)}`;
    // On one line, the item is as tall as its button, with the connector beside it
    if (
      step.item.bottom - step.item.top >
      step.button.bottom - step.button.top + TOLERANCE
    ) {
      problems.push(`${name} wraps on more than one line`);
    }
    if (
      step.item.right - step.item.left <
      step.button.right - step.button.left + step.connector - TOLERANCE
    ) {
      problems.push(`${name} has its connector above or below its number`);
    }
    if (Math.abs(middle(step.number) - middle(layout.steps)) > TOLERANCE) {
      problems.push(
        `the number of ${name} is centered at ${px(middle(step.number))}, the steps at ${px(middle(layout.steps))}`,
      );
    }
    if (i > 0 && step.number.left < layout.items[i - 1].number.right) {
      problems.push(`the number of ${name} is not right of the previous one`);
    }
  });
  return problems;
}

/** The brand and the steps fit inside the top bar, on one line. */
async function expectTopBarOnOneLine(page: Page): Promise<void> {
  expect(
    topBarProblems(await topBarLayout(page)),
    'the top bar fits on one line',
  ).toEqual([]);
}

/**
 * The names in the top bar, in Brazilian Portuguese: on phones up to 520 px only the step
 * numbers; from 521 to 760 px the name of the current step too; above that, every name. The
 * language is fixed, so there is no language picker.
 */
async function expectTopBarNames(
  page: Page,
  screen: Screen,
  current: number,
  language: Language,
): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', language.lang);
  await expect(page.getByTestId('language')).toHaveCount(0);
  for (let i: number = 0; i < 4; i++) {
    const label: Locator = page
      .getByTestId(`step-${String(i)}`)
      .locator('.step-label');
    const shown: boolean =
      screen.width > 760 || (screen.width > 520 && i === current);
    if (shown) {
      await expect(label).toBeVisible();
      await expect(label).toHaveText(language.steps[i]);
    } else {
      await expect(label).toBeHidden();
    }
  }
}

/**
 * Why an element cannot be tapped where it is, or `''` when it can: it must be inside the
 * screen, not cut by a container that clips it, not under another element, and not scrolled
 * into view by a container the user cannot scroll. Runs in the page, so it uses nothing outside.
 */
function blockedReason(element: Element): string {
  const describe = (node: Element | null): string =>
    node
      ? `<${node.tagName.toLowerCase()} class="${node.getAttribute('class') ?? ''}">`
      : 'nothing';
  const box: DOMRect = element.getBoundingClientRect();
  const slack: number = 0.5;
  if (box.width === 0 || box.height === 0) return 'it has no size';
  if (
    box.left < -slack ||
    box.top < -slack ||
    box.right > window.innerWidth + slack ||
    box.bottom > window.innerHeight + slack
  ) {
    return `it spans ${box.left.toFixed(1)},${box.top.toFixed(1)} to ${box.right.toFixed(1)},${box.bottom.toFixed(1)}, outside the ${String(window.innerWidth)} × ${String(window.innerHeight)} screen`;
  }
  for (
    let parent: Element | null = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style: CSSStyleDeclaration = getComputedStyle(parent);
    const clip: DOMRect = parent.getBoundingClientRect();
    const scrollable = (overflow: string): boolean =>
      overflow === 'auto' || overflow === 'scroll';
    if (
      style.overflowX !== 'visible' &&
      (box.left < clip.left - slack || box.right > clip.right + slack)
    ) {
      return `it is cut at the side by ${describe(parent)}`;
    }
    if (
      style.overflowY !== 'visible' &&
      (box.top < clip.top - slack || box.bottom > clip.bottom + slack)
    ) {
      return `it is cut at the top or bottom by ${describe(parent)}`;
    }
    if (parent.scrollTop > 0 && !scrollable(style.overflowY)) {
      return `${describe(parent)} was scrolled to show it, but the user cannot scroll it`;
    }
    if (parent.scrollLeft > 0 && !scrollable(style.overflowX)) {
      return `${describe(parent)} was scrolled to show it, but the user cannot scroll it`;
    }
  }
  // The middle and both ends of the button (rounded ones included) must receive the tap
  const y: number = (box.top + box.bottom) / 2;
  const inset: number = Math.min(box.height / 2, box.width / 4);
  for (const x of [
    box.left + inset,
    (box.left + box.right) / 2,
    box.right - inset,
  ]) {
    const hit: Element | null = document.elementFromPoint(x, y);
    if (!hit || !element.contains(hit)) {
      return `at ${x.toFixed(1)},${y.toFixed(1)} it is covered by ${describe(hit)}`;
    }
  }
  return '';
}

/** A control can be scrolled into view, if needed, and then tapped. */
async function expectTappable(target: Locator, name: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await expect
    .poll(async (): Promise<string> => target.evaluate(blockedReason), {
      message: `${name} is on screen and can be tapped`,
    })
    .toBe('');
}

/** Where the content of the stage is, at the top and at the bottom of its scroll. */
interface StageReach {
  /** Whether the user can scroll the stage up and down. */
  scrollable: boolean;
  overflows: boolean;
  /** How far the highest content is above the top of the stage, scrolled to the top. */
  cutAtTop: number;
  /** How far the lowest content is below the bottom of the stage, scrolled to the bottom. */
  cutAtBottom: number;
}

/**
 * Nothing of the Upload step is cut without a way to reach it: scrolled to the top, its highest
 * content is in view; scrolled to the bottom, its lowest; and if it overflows, it scrolls.
 */
async function expectUploadNotCut(page: Page): Promise<void> {
  const reach: StageReach = await page
    .locator('.stage')
    .evaluate((stage: HTMLElement): StageReach => {
      const style: CSSStyleDeclaration = getComputedStyle(stage);
      const content: Element[] = [...stage.querySelectorAll('*')].filter(
        (element: Element): boolean => {
          const rect: DOMRect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        },
      );
      const top: number = stage.getBoundingClientRect().top + stage.clientTop;
      const bottom: number = top + stage.clientHeight;
      stage.scrollTop = 0;
      const highest: number = Math.min(
        ...content.map((e: Element): number => e.getBoundingClientRect().top),
      );
      stage.scrollTop = stage.scrollHeight;
      const lowest: number = Math.max(
        ...content.map(
          (e: Element): number => e.getBoundingClientRect().bottom,
        ),
      );
      stage.scrollTop = 0;
      return {
        scrollable: style.overflowY === 'auto' || style.overflowY === 'scroll',
        overflows: stage.scrollHeight > stage.clientHeight,
        cutAtTop: Math.max(0, Math.round(top - highest)),
        cutAtBottom: Math.max(0, Math.round(lowest - bottom)),
      };
    });
  expect(reach.cutAtTop, 'content cut above the Upload step').toBe(0);
  expect(reach.cutAtBottom, 'content cut below the Upload step').toBe(0);
  if (reach.overflows) {
    expect(reach.scrollable, 'the overflowing Upload step scrolls').toBe(true);
  }
}

/**
 * The preview is centered in the stage, not pushed against an edge. The stage starts at the left
 * edge of the screen and, up to 760 px, takes its whole width.
 */
async function expectCentered(
  page: Page,
  preview: Locator,
  screen: Screen,
): Promise<void> {
  await expect(preview).toBeVisible();
  const stage: Locator = page.locator('.stage');
  // Polled: the preview takes its size once its image is drawn
  await expect
    .poll(
      async (): Promise<number> => {
        const box: Box = await boxOf(preview);
        const area: Box = await boxOf(stage);
        return Math.abs(
          (box.left + box.right) / 2 - (area.left + area.right) / 2,
        );
      },
      { message: 'distance of the preview from the middle of the stage' },
    )
    .toBeLessThanOrEqual(TOLERANCE);
  const area: Box = await boxOf(stage);
  expect(area.left, 'the stage starts at the left edge').toBe(0);
  if (screen.width <= 760) {
    expect(area.right, 'the stage takes the whole width').toBe(screen.width);
  }
}

/** The buttons pinned to the bottom of the panel of the current step, once there are `count`. */
async function panelButtons(page: Page, count: number): Promise<Locator[]> {
  const buttons: Locator = page.locator('.panel-actions button');
  await expect(buttons).toHaveCount(count);
  return buttons.all();
}

/** Checks one step: page width, top bar, and that its controls can be tapped. */
async function expectStepFits(
  page: Page,
  screen: Screen,
  current: number,
  language: Language,
  controls: [string, Locator][],
): Promise<void> {
  await expectPageFits(page, screen);
  await expectTopBarOnOneLine(page);
  await expectTopBarNames(page, screen, current, language);
  for (const step of [0, 1, 2, 3]) {
    await expectTappable(
      page.getByTestId(`step-${String(step)}`),
      `step ${String(step + 1)} of the top bar`,
    );
  }
  for (const [name, control] of controls) {
    await expectTappable(control, name);
  }
  // Scrolling to the controls must not have revealed a wider page
  await expectPageFits(page, screen);
}

/** The top bar marks the step at this position, from 0, as the current one. */
async function expectCurrentStep(page: Page, step: number): Promise<void> {
  await expect(page.getByTestId(`step-${String(step)}`)).toHaveAttribute(
    'aria-current',
    'step',
  );
}

/**
 * Goes through every step with the photos and checks each: Upload empty and with the documents,
 * Crop, Adjust and Export. Uses test ids only, so it does not depend on the language.
 */
async function walkSteps(
  page: Page,
  screen: Screen,
  files: Fixture[],
  language: Language,
): Promise<void> {
  await openApp(page);
  await expectUploadNotCut(page);
  await expectStepFits(page, screen, 0, language, [
    ['"Take photo"', page.getByTestId('upload-camera')],
    ['"Upload images"', page.getByTestId('upload-files')],
  ]);
  await expectUploadNotCut(page);

  await uploadImages(page, files);
  await expectUploadNotCut(page);
  await expectStepFits(page, screen, 0, language, [
    ['the take-photo button of the carousel', page.getByTestId('add-camera')],
    ['the upload button of the carousel', page.getByTestId('add-upload')],
    ['"Continue"', page.getByTestId('upload-continue')],
  ]);
  await expectUploadNotCut(page);

  await page.getByTestId('upload-continue').click();
  await expectCurrentStep(page, 1);
  await expect(page.getByTestId('corner-editor')).toBeVisible();
  await expect(page.getByTestId('crop')).toBeEnabled();
  const [cropContinue, cropBack] = await panelButtons(page, 2);
  await expectStepFits(page, screen, 1, language, [
    ['"Detect automatically"', page.getByTestId('auto-detect')],
    ['"Continue" of Crop', cropContinue],
    ['"Back" of Crop', cropBack],
  ]);
  await expectCentered(page, page.getByTestId('corner-editor'), screen);

  await page.getByTestId('crop').click();
  await expectCurrentStep(page, 2);
  await resultSize(page);
  const [adjustContinue, adjustBack] = await panelButtons(page, 2);
  const adjustControls: [string, Locator][] = [
    ['"Continue" of Adjust', adjustContinue],
    ['"Back" of Adjust', adjustBack],
  ];
  if (files.length > 1) {
    adjustControls.unshift(['"Apply to all"', page.getByTestId('apply-all')]);
  }
  await expectStepFits(page, screen, 2, language, adjustControls);
  await expectCentered(page, page.getByTestId('result'), screen);

  await page.getByTestId('continue').click();
  await expectCurrentStep(page, 3);
  await resultSize(page);
  await expect(page.getByTestId('download')).toBeEnabled();
  const [download, exportBack, restart] = await panelButtons(page, 3);
  await expectStepFits(page, screen, 3, language, [
    ['"Export"', download],
    ['"Back" of Export', exportBack],
    ['"New scan"', restart],
  ]);
  await expectCentered(page, page.getByTestId('result'), screen);
}

/** How far the large carousel and the page are scrolled sideways. */
interface CarouselScroll {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
  box: Box;
  /** Sideways scroll of the page. */
  pageScroll: number;
  /** Left edge of the first document, from the left edge of the carousel. */
  firstTile: number;
}

/** Reads the scroll of the large carousel. Runs in the page, so it uses nothing outside. */
function readScroll(carousel: HTMLElement): CarouselScroll {
  const first: Element | null = carousel.querySelector('.doc-item');
  if (!first) throw new Error('No document in the carousel');
  const rect: DOMRect = carousel.getBoundingClientRect();
  return {
    scrollWidth: carousel.scrollWidth,
    clientWidth: carousel.clientWidth,
    scrollLeft: carousel.scrollLeft,
    box: {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    },
    pageScroll: window.scrollX,
    firstTile: first.getBoundingClientRect().left - rect.left,
  };
}

/** Share of the screen height the panel may take open: what is left goes to the document. */
const OPEN_PANEL_SHARE: number = 0.55;

/** Share of the screen height the panel of the Adjust step takes once its options collapse. */
const COLLAPSED_PANEL_SHARE: number = 0.2;

/** How tall a box is on the screen, in CSS pixels. */
function heightOf(box: Box): number {
  return box.bottom - box.top;
}

/** Opens the Adjust step with three documents, its preview rendered. */
async function openAdjust(page: Page): Promise<void> {
  await openApp(page);
  await uploadImages(page, THREE_DOCUMENTS);
  await page.getByTestId('upload-continue').click();
  await page.getByTestId('crop').click();
  await resultSize(page);
}

/** The handle of the panel tells whether the options of the panel are collapsed or open. */
async function expectCollapsed(page: Page, collapsed: boolean): Promise<void> {
  await expect(page.getByTestId('panel-toggle')).toHaveAttribute(
    'aria-expanded',
    String(!collapsed),
  );
}

test.describe('Phone layout', (): void => {
  for (const screen of PORTRAIT) {
    test.describe(`${screen.name}, ${String(screen.width)} × ${String(screen.height)}`, (): void => {
      test.use(phone(screen));

      test('every step fits the screen width, with the top bar on one line and every button in reach', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await walkSteps(page, screen, THREE_DOCUMENTS, PORTUGUESE);
      });
    });
  }

  // The browser stays in English: the app ignores it and shows Brazilian Portuguese
  for (const screen of TOP_BAR_SCREENS) {
    test.describe(`${PORTUGUESE.lang}, ${screen.name}, ${String(screen.width)} × ${String(screen.height)}`, (): void => {
      test.use(phone(screen));

      test('the top bar fits on one line in every step, with the names this width has room for', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await walkSteps(page, screen, ['invoice.jpg'], PORTUGUESE);
      });
    });
  }

  for (const screen of LANDSCAPE) {
    test.describe(`${screen.name}, ${String(screen.width)} × ${String(screen.height)}`, (): void => {
      test.use(phone(screen));

      test('the Upload step scrolls to every button, empty and with three documents, and every step fits', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await walkSteps(page, screen, THREE_DOCUMENTS, PORTUGUESE);
      });
    });
  }

  test.describe(`${IPHONE_PRO_MAX.name}, large carousel`, (): void => {
    test.use(phone(IPHONE_PRO_MAX));

    test('the large carousel scrolls sideways inside itself, while the page does not', async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await openApp(page);
      await uploadImages(page, THREE_DOCUMENTS);
      const carousel: Locator = page.locator('.doc-carousel.is-large');

      const before: CarouselScroll = await carousel.evaluate(readScroll);
      // Three 192 px tiles and the add tile cannot fit in 440 px: about a tile and a half is hidden
      expect(before.scrollWidth - before.clientWidth).toBeGreaterThan(150);
      expect(before.scrollLeft).toBe(0);
      expect(before.firstTile).toBeGreaterThanOrEqual(0);
      expect(before.box.left).toBeGreaterThanOrEqual(0);
      expect(before.box.right).toBeLessThanOrEqual(IPHONE_PRO_MAX.width);
      await expectPageFits(page, IPHONE_PRO_MAX);
      // The add tile starts past the right edge of the carousel
      await expect
        .poll(async (): Promise<string> =>
          page.getByTestId('add-upload').evaluate(blockedReason),
        )
        .toMatch(/cut at the side|outside the/);

      await expectTappable(
        page.getByTestId('add-upload'),
        'the upload button of the carousel',
      );
      await expectTappable(
        page.getByTestId('add-camera'),
        'the take-photo button of the carousel',
      );
      const after: CarouselScroll = await carousel.evaluate(readScroll);
      expect(after.scrollLeft, 'the carousel scrolled').toBeGreaterThan(150);
      expect(after.pageScroll, 'the page did not scroll').toBe(0);
      expect(
        after.firstTile,
        'the first document went out on the left',
      ).toBeLessThan(0);
      await expectPageFits(page, IPHONE_PRO_MAX);
    });
  });
});

test.describe('Collapsible panel on phones', (): void => {
  for (const screen of PORTRAIT) {
    test.describe(`${screen.name}, ${String(screen.width)} × ${String(screen.height)}`, (): void => {
      test.use(phone(screen));

      test('the open panel leaves most of the screen to the document, and collapsing it leaves even more', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await openAdjust(page);
        await settle(page);
        const panel: Locator = page.locator('.panel');
        const rotateRight: Locator = page.getByRole('button', {
          name: 'Direita',
          exact: true,
        });
        await expectCollapsed(page, false);
        const open: Box = await boxOf(panel);
        const openPreview: Box = await boxOf(page.getByTestId('result'));
        expect(heightOf(open)).toBeLessThanOrEqual(
          screen.height * OPEN_PANEL_SHARE + TOLERANCE,
        );
        await expectTappable(page.getByTestId('apply-all'), '"Apply to all"');
        await expectTappable(rotateRight, '"Direita"');

        await page.getByTestId('panel-toggle').click();
        await expectCollapsed(page, true);
        await expect(page.getByTestId('apply-all')).toBeHidden();
        await expect(rotateRight).toBeHidden();
        await expect
          .poll(async (): Promise<number> => heightOf(await boxOf(panel)))
          .toBeLessThanOrEqual(screen.height * COLLAPSED_PANEL_SHARE);
        await expect(page.getByTestId('result-size')).toBeVisible();
        const [next, back] = await panelButtons(page, 2);
        await expectTappable(next, '"Continue"');
        await expectTappable(back, '"Back"');
        await expect
          .poll(async (): Promise<number> =>
            heightOf(await boxOf(page.getByTestId('result'))),
          )
          .toBeGreaterThan(heightOf(openPreview));
        await expectPageFits(page, screen);

        await page.getByTestId('panel-toggle').click();
        await expectCollapsed(page, false);
        await expectTappable(page.getByTestId('apply-all'), '"Apply to all"');
      });
    });
  }

  test.describe('iPhone 14', (): void => {
    test.use(phone({ name: 'iPhone 14', width: 390, height: 844 }));

    test('keeps the choice in the next steps and on the next visit', async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await openAdjust(page);
      await page.getByTestId('panel-toggle').click();
      await expectCollapsed(page, true);

      await page.getByTestId('continue').click();
      await resultSize(page);
      await expectCollapsed(page, true);
      await expect(page.getByTestId('margins')).toBeHidden();
      await expectTappable(page.getByTestId('download'), '"Export"');

      await page.reload();
      await uploadImages(page, ['invoice.jpg']);
      await page.getByTestId('upload-continue').click();
      await expectCollapsed(page, true);
      await expect(page.getByTestId('auto-detect')).toBeHidden();
    });

    test.describe('without animations', (): void => {
      // The handle moves while the panel animates: a swipe must start where it ends up
      test.use({ reducedMotion: 'reduce' });

      test('a swipe down the handle collapses the panel and a swipe up opens it', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await openAdjust(page);
        const swipe = async (distance: number): Promise<void> => {
          const handle: Box = await boxOf(page.getByTestId('panel-toggle'));
          const x: number = (handle.left + handle.right) / 2;
          const y: number = (handle.top + handle.bottom) / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, y + distance, { steps: 5 });
          await page.mouse.up();
        };

        await swipe(60);
        await expectCollapsed(page, true);

        await swipe(-60);
        await expectCollapsed(page, false);
      });
    });
  });

  test('on a computer, the panel has no handle and always shows its options', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await page.addInitScript((): void => {
      localStorage.setItem('docscanify.panelCollapsed', 'true');
    });
    await openAdjust(page);

    await expect(page.getByTestId('panel-toggle')).toBeHidden();
    await expect(page.getByTestId('apply-all')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Direita', exact: true }),
    ).toBeVisible();
  });
});
