import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  expect,
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
  FIXTURE_CORNERS,
  maxCornerError,
  openApp,
  type PdfInfo,
  readImage,
  readPdf,
  uploadImages,
} from '@/test-support/e2e/app';

/** Where the production build is served, as in `playwright.config.ts`. */
const APP_ORIGIN: string = 'http://localhost:4173';

/** Description of the app in each language, from `src/i18n/locales`. */
const DESCRIPTIONS: Record<'en' | 'es' | 'pt-BR', string> = {
  en: 'Scan documents, take photos or upload images, crop, adjust, and export to PDF, PNG, or JPG. Everything is processed on your device.',
  es: 'Escanea documentos, toma fotos o sube imágenes, recorta, ajusta y exporta a PDF, PNG o JPG. Todo se procesa en tu dispositivo.',
  'pt-BR':
    'Escaneie documentos, fotografe ou envie imagens, recorte, ajuste e exporte em PDF, PNG ou JPG. Tudo é processado no seu dispositivo.',
};

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

/** The members of a web app manifest the tests read. */
interface WebManifest {
  lang: string;
  dir: string;
  description: string;
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: ManifestIcon[];
}

/** The icons every manifest lists. */
const ICONS: ManifestIcon[] = [
  { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  {
    src: 'icons/icon-192.png',
    sizes: '192x192',
    type: 'image/png',
    purpose: 'any',
  },
  {
    src: 'icons/icon-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'any',
  },
  {
    src: 'icons/maskable-192.png',
    sizes: '192x192',
    type: 'image/png',
    purpose: 'maskable',
  },
  {
    src: 'icons/maskable-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  },
];

/** The state of the service worker registration of the page. */
interface WorkerState {
  /** The page is controlled by a service worker. */
  controlled: boolean;
  /** State of the active worker, or null. */
  active: string | null;
  /** A new version is being installed. */
  installing: boolean;
  /** A new version is installed and waits to take over. */
  waiting: boolean;
}

/** Reads the state of the service worker registration of the page, from inside it. */
async function workerState(page: Page): Promise<WorkerState> {
  return page.evaluate(async (): Promise<WorkerState> => {
    const registration: ServiceWorkerRegistration | undefined =
      await navigator.serviceWorker.getRegistration();
    return {
      controlled: navigator.serviceWorker.controller !== null,
      active: registration?.active?.state ?? null,
      installing: !!registration?.installing,
      waiting: !!registration?.waiting,
    };
  });
}

/**
 * Waits until the service worker is installed (every file of the app stored, opencv.js included),
 * activated and controlling the page: from then on, the app opens offline.
 */
async function waitForInstall(page: Page): Promise<void> {
  await expect
    .poll(async (): Promise<WorkerState> => workerState(page), {
      timeout: 60_000,
    })
    .toEqual({
      controlled: true,
      active: 'activated',
      installing: false,
      waiting: false,
    });
}

/** Asks the service worker registration to look for a new version, as the hourly check does. */
async function checkForUpdate(page: Page): Promise<void> {
  await page.evaluate(async (): Promise<void> => {
    const registration: ServiceWorkerRegistration | undefined =
      await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('No service worker registration');
    await registration.update();
  });
}

/**
 * A server in front of the production build that can publish a new version of the app: once
 * `publishNewVersion` is called, `sw.js` is served with a comment added, so the browser finds a
 * new service worker. Chrome does not let Playwright route the requests that check a service worker
 * for updates, so the new version is served by this server instead; the files in `dist/` are
 * never changed. Each server has its own port, so its origin starts with no service worker.
 */
interface VersionedServer {
  /** Origin of the server, such as `http://localhost:51234`. */
  origin: string;
  /** Times `sw.js` was requested. */
  workerRequests(): number;
  /** From now on, serves the new version of `sw.js`. */
  publishNewVersion(): void;
  close(): Promise<void>;
}

/**
 * Starts a {@link VersionedServer} on a free port of localhost. It forwards every request to the
 * production build at {@link APP_ORIGIN}, uncached, and answers 502 when that fails.
 */
async function startVersionedServer(): Promise<VersionedServer> {
  let version: number = 1;
  let workerRequests: number = 0;

  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url: string = request.url ?? '/';
    const upstream: Response = await fetch(`${APP_ORIGIN}${url}`);
    let body: Buffer = Buffer.from(await upstream.arrayBuffer());
    if (url.split('?')[0] === '/sw.js') {
      workerRequests++;
      if (version > 1) {
        body = Buffer.concat([
          body,
          Buffer.from(`\n// Version ${String(version)}\n`),
        ]);
      }
    }
    response.writeHead(upstream.status, {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
    });
    response.end(body);
  };

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse): void => {
      respond(request, response).catch((): void => {
        response.writeHead(502);
        response.end();
      });
    },
  );
  await new Promise<void>((resolve: () => void): void => {
    server.listen(0, 'localhost', resolve);
  });
  const { port }: AddressInfo = server.address() as AddressInfo;

  return {
    origin: `http://localhost:${String(port)}`,
    workerRequests: (): number => workerRequests,
    publishNewVersion: (): void => {
      version++;
    },
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve: () => void): void => {
        server.close((): void => {
          resolve();
        });
      });
    },
  };
}

test.describe('web app manifests', (): void => {
  for (const lang of ['en', 'es', 'pt-BR'] as const) {
    test(`manifest.${lang}.webmanifest is JSON with its language, its description, the shared id and the icons`, async ({
      request,
    }: {
      request: APIRequestContext;
    }): Promise<void> => {
      const response: APIResponse = await request.get(
        `/manifest.${lang}.webmanifest`,
      );
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(
        /^application\/manifest\+json/,
      );
      const manifest: WebManifest = (await response.json()) as WebManifest;

      expect(manifest.lang).toBe(lang);
      expect(manifest.dir).toBe('ltr');
      expect(manifest.description).toBe(DESCRIPTIONS[lang]);
      // The same app in every language
      expect(manifest.id).toBe('./');
      expect(manifest.start_url).toBe('./');
      expect(manifest.scope).toBe('./');
      expect(manifest.name).toBe('DocScanner');
      expect(manifest.short_name).toBe('DocScanner');
      expect(manifest.display).toBe('standalone');
      expect(manifest.icons).toEqual(ICONS);
    });
  }

  test('every icon of the manifests resolves to an image of its type and size', async ({
    request,
  }: {
    request: APIRequestContext;
  }): Promise<void> => {
    const manifestUrl: string = `${APP_ORIGIN}/manifest.pt-BR.webmanifest`;
    const manifest: WebManifest = (await (
      await request.get(manifestUrl)
    ).json()) as WebManifest;

    for (const icon of manifest.icons) {
      // Icon paths are relative to the manifest
      const url: string = new URL(icon.src, manifestUrl).href;
      const response: APIResponse = await request.get(url);
      expect(response.status(), url).toBe(200);
      expect(response.headers()['content-type'], url).toContain(icon.type);
      const data: Buffer = await response.body();
      if (icon.type === 'image/svg+xml') {
        expect(data.toString('utf8'), url).toContain('<svg');
      } else {
        const [width, height]: number[] = icon.sizes.split('x').map(Number);
        expect(readImage(data), url).toEqual({ format: 'png', width, height });
      }
    }
  });
});

test.describe('installed app', (): void => {
  test('the service worker activates and controls the page on the first visit', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await waitForInstall(page);

    const scriptUrl: string | undefined = await page.evaluate(
      (): string | undefined => navigator.serviceWorker.controller?.scriptURL,
    );
    expect(scriptUrl).toBe(`${APP_ORIGIN}/sw.js`);
    // A first install is not a new version: no notice
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('opens offline after the first visit, and a whole scan works offline', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }): Promise<void> => {
    await openApp(page);
    await waitForInstall(page);

    await context.setOffline(true);
    // The network is really cut: a file the service worker does not keep fails to load
    const reachable: boolean = await page.evaluate(async (): Promise<boolean> =>
      fetch(`/not-cached-${String(Date.now())}.txt`).then(
        (): boolean => true,
        (): boolean => false,
      ),
    );
    expect(reachable).toBe(false);

    await page.reload();
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Fotografe ou envie imagens dos documentos',
      }),
    ).toBeVisible();

    // Upload: detection needs opencv.js, which comes from the service worker
    await uploadImages(page, ['invoice.jpg']);
    await page.getByTestId('upload-continue').click();

    // Crop: the sheet is found
    expect(
      maxCornerError(await editorCorners(page), FIXTURE_CORNERS['invoice.jpg']),
    ).toBeLessThan(40);
    await page.getByTestId('crop').click();

    // Adjust, then Export as a single PDF
    await expect(page.getByTestId('result-size')).toHaveText(/^\d+ × \d+ px$/);
    await clickContinue(page);
    await expect(page.getByTestId('step-3')).toHaveAttribute(
      'aria-current',
      'step',
    );
    const download: Locator = page.getByTestId('download');
    await expect(download).toBeEnabled();
    const file: DownloadedFile = await downloadFrom(
      page,
      async (): Promise<void> => {
        await download.click();
      },
    );

    expect(file.name).toMatch(/\.pdf$/);
    const pdf: PdfInfo = await readPdf(file.data);
    expect(pdf.pageCount).toBe(1);
    // Still offline the whole time
    expect(await page.evaluate((): boolean => navigator.onLine)).toBe(false);
  });
});

test.describe('new version notice', (): void => {
  let server: VersionedServer;

  test.beforeEach(async (): Promise<void> => {
    server = await startVersionedServer();
  });

  test.afterEach(async (): Promise<void> => {
    await server.close();
  });

  /** Opens the app from the versioned server and waits until it is installed. */
  async function installApp(page: Page): Promise<void> {
    await page.goto(`${server.origin}/`);
    await expect(page.getByTestId('upload-files')).toBeVisible();
    await waitForInstall(page);
  }

  function updateToast(page: Page): Locator {
    return page
      .getByTestId('toast')
      .filter({ hasText: 'Nova versão disponível.' });
  }

  test('a new service worker shows the notice, and Update reloads into the new version', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await installApp(page);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    const requestsBefore: number = server.workerRequests();

    server.publishNewVersion();
    await checkForUpdate(page);

    const toast: Locator = updateToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-kind', 'info');
    await expect(toast.locator('p')).toHaveText('Nova versão disponível.');
    await expect(toast.getByTestId('toast-action')).toHaveText('Atualizar');
    expect(server.workerRequests()).toBeGreaterThan(requestsBefore);
    // The new version waits for the user: the page is still on the old one
    expect(await workerState(page)).toEqual({
      controlled: true,
      active: 'activated',
      installing: false,
      waiting: true,
    });

    // Marks this page, to tell it apart from the reloaded one
    await page.evaluate((): void => {
      (window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
    });
    const reloaded: Promise<unknown> = page.waitForEvent('load');
    await toast.getByTestId('toast-action').click();
    await reloaded;

    await expect(page.getByTestId('upload-files')).toBeVisible();
    expect(
      await page.evaluate(
        (): boolean =>
          (window as unknown as { beforeUpdate?: boolean }).beforeUpdate ===
          true,
      ),
    ).toBe(false);
    // The waiting version took over
    await expect
      .poll(async (): Promise<WorkerState> => workerState(page))
      .toEqual({
        controlled: true,
        active: 'activated',
        installing: false,
        waiting: false,
      });
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('with documents open, the notice warns that updating discards them', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await installApp(page);
    await uploadImages(page, ['invoice.jpg']);

    server.publishNewVersion();
    await checkForUpdate(page);

    const toast: Locator = updateToast(page);
    await expect(toast.locator('p')).toHaveText(
      'Nova versão disponível. Atualizar agora descarta os documentos abertos.',
    );
    await expect(toast.getByTestId('toast-action')).toHaveText('Atualizar');
    // The notice does not reload by itself: the documents are still there
    await expect(documentTiles(page)).toHaveCount(1);
  });

  test('closing the notice keeps the current version and the documents', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await installApp(page);
    await uploadImages(page, ['invoice.jpg']);
    server.publishNewVersion();
    await checkForUpdate(page);
    const toast: Locator = updateToast(page);
    await expect(toast).toBeVisible();

    await toast.getByRole('button', { name: 'Fechar aviso' }).click();

    await expect(toast).toHaveCount(0);
    await expect(documentTiles(page)).toHaveCount(1);
    expect(await workerState(page)).toEqual({
      controlled: true,
      active: 'activated',
      installing: false,
      waiting: true,
    });
  });

  test('documents opened while the notice shows add the warning to it', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await installApp(page);
    server.publishNewVersion();
    await checkForUpdate(page);
    const toast: Locator = updateToast(page);
    await expect(toast.locator('p')).toHaveText('Nova versão disponível.');

    await uploadImages(page, ['invoice.jpg']);

    await expect(toast).toHaveCount(1);
    await expect(toast.locator('p')).toHaveText(
      'Nova versão disponível. Atualizar agora descarta os documentos abertos.',
    );
  });

  test('an app left open checks for a new version every hour', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    // Counts the update checks as they start, so a check that has not happened yet is known
    await page.addInitScript((): void => {
      const state: { updateChecks: number } = window as unknown as {
        updateChecks: number;
      };
      state.updateChecks = 0;
      type Update = (
        this: ServiceWorkerRegistration,
      ) => Promise<ServiceWorkerRegistration>;
      const original: Update = Reflect.get(
        ServiceWorkerRegistration.prototype,
        'update',
      );
      ServiceWorkerRegistration.prototype.update = async function (
        this: ServiceWorkerRegistration,
      ): Promise<ServiceWorkerRegistration> {
        state.updateChecks++;
        return original.call(this);
      };
    });
    const updateChecks: () => Promise<number> = async (): Promise<number> =>
      page.evaluate(
        (): number =>
          (window as unknown as { updateChecks: number }).updateChecks,
      );
    await page.clock.install();
    await installApp(page);
    // The hourly check starts once the service worker is registered
    const checksBefore: number = await updateChecks();
    server.publishNewVersion();

    await page.clock.fastForward('59:00');
    expect(await updateChecks()).toBe(checksBefore);
    await expect(page.getByTestId('toast')).toHaveCount(0);

    await page.clock.fastForward('01:00');
    expect(await updateChecks()).toBe(checksBefore + 1);
    await expect(updateToast(page)).toBeVisible();
  });

  test('without a new version, checking for updates shows no notice', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await installApp(page);
    const requestsBefore: number = server.workerRequests();

    await checkForUpdate(page);

    expect(server.workerRequests()).toBeGreaterThan(requestsBefore);
    expect(await workerState(page)).toEqual({
      controlled: true,
      active: 'activated',
      installing: false,
      waiting: false,
    });
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});
