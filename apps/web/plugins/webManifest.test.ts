// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HtmlTagDescriptor, Plugin } from 'vite';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { DEFAULT_LOCALE } from '../src/i18n/locale';
import { webManifest } from './webManifest';

/** The app, whose real messages the plugin reads. */
const APP_ROOT: string = path.resolve(import.meta.dirname, '..');

const LOCALES_DIR: string = 'src/i18n/locales';

/** What every language's manifest shares. */
const SHARED: Record<string, unknown> = {
  id: './',
  name: 'DocScanner',
  short_name: 'DocScanner',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: '#fcf8f3',
  theme_color: '#fcf8f3',
  categories: ['productivity', 'utilities'],
  icons: [
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
  ],
};

interface Manifest {
  lang: string;
  dir: string;
  description: string;
  icons: { src: string }[];
  [member: string]: unknown;
}

interface Emitted {
  type: string;
  fileName: string;
  source: string;
}

type HookFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Calls a plugin hook, whether Vite would see it as a function or as `{ handler }`. */
function callHook(
  hook: unknown,
  context: unknown,
  ...args: unknown[]
): unknown {
  const handler: unknown =
    typeof hook === 'function'
      ? hook
      : (hook as { handler?: unknown } | undefined)?.handler;
  if (typeof handler !== 'function')
    throw new Error('The plugin has no such hook');
  return (handler as HookFunction).apply(context, args);
}

/** The plugin, after Vite resolved a config with this root and base. */
function resolvedPlugin(root: string, base: string = '/'): Plugin {
  const plugin: Plugin = webManifest();
  callHook(plugin.configResolved, {}, { root, base });
  return plugin;
}

/** The files the build writes. */
function build(plugin: Plugin): Emitted[] {
  const emitFile: Mock<(file: Emitted) => string> = vi.fn(
    (file: Emitted): string => file.fileName,
  );
  callHook(plugin.generateBundle, { emitFile }, {}, {}, false);
  return emitFile.mock.calls.map(([file]: [Emitted]) => file);
}

interface DevResponse {
  /** Whether the middleware passed the request on. */
  passed: boolean;
  headers: Record<string, string>;
  body: string | undefined;
}

/** The dev server's answer to a request for `url`. */
function request(plugin: Plugin, url: string | undefined): DevResponse {
  let middleware: HookFunction | undefined;
  const server: unknown = {
    middlewares: {
      use: (handler: HookFunction): void => {
        middleware = handler;
      },
    },
  };
  callHook(plugin.configureServer, {}, server);
  if (!middleware) throw new Error('The plugin added no middleware');

  const response: DevResponse = { passed: false, headers: {}, body: undefined };
  const res: unknown = {
    setHeader: (name: string, value: string): void => {
      response.headers[name] = value;
    },
    end: (body: string): void => {
      response.body = body;
    },
  };
  const next = (): void => {
    response.passed = true;
  };
  middleware.call(undefined, { url }, res, next);
  return response;
}

interface IndexHtml {
  html: string;
  tags: HtmlTagDescriptor[];
}

/** What the plugin does to `html`, as Vite asks it for `index.html`. */
const transformIndexHtml = (plugin: Plugin, html: string): IndexHtml =>
  callHook(plugin.transformIndexHtml, {}, html, {
    path: '/index.html',
    filename: 'index.html',
  }) as IndexHtml;

/** The description in a language file of the app at `root`. */
const readDescription = (root: string, locale: string): string =>
  (
    JSON.parse(
      fs.readFileSync(path.join(root, LOCALES_DIR, `${locale}.json`), 'utf8'),
    ) as { app: { description: string } }
  ).app.description;

/** An app root with its own language files, so tests control which languages exist. */
function fixtureRoot(files: Record<string, string>): string {
  const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'web-manifest-'));
  const dir: string = path.join(root, LOCALES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  return root;
}

/** Contents of a language file with this description, plus a message the plugin ignores. */
const messages = (description: string): string =>
  JSON.stringify({ app: { description, other: 'ignored' } });

describe('webManifest', (): void => {
  let fixture: string;

  beforeEach((): void => {
    fixture = fixtureRoot({
      [`${DEFAULT_LOCALE}.json`]: messages('Default description'),
      'de.json': messages('Deutsche Beschreibung'),
      'fr-CA.json': messages('Description française'),
      'README.md': '# Not a language',
    });
  });

  afterEach((): void => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('is a Vite plugin named web-manifest', (): void => {
    expect(webManifest().name).toBe('web-manifest');
  });

  describe('manifests', (): void => {
    it('builds one manifest per JSON file of the locales folder, and nothing for other files', (): void => {
      const names: string[] = build(resolvedPlugin(fixture))
        .map((file: Emitted) => file.fileName)
        .sort();

      expect(names).toEqual(
        [
          `manifest.${DEFAULT_LOCALE}.webmanifest`,
          'manifest.de.webmanifest',
          'manifest.fr-CA.webmanifest',
        ].sort(),
      );
    });

    it('gives each manifest its language, left-to-right direction and description, and the shared members', (): void => {
      const files: Emitted[] = build(resolvedPlugin(fixture));
      const de: Emitted | undefined = files.find(
        (file: Emitted) => file.fileName === 'manifest.de.webmanifest',
      );

      expect(de?.type).toBe('asset');
      expect(JSON.parse(de?.source ?? '{}')).toEqual({
        lang: 'de',
        dir: 'ltr',
        description: 'Deutsche Beschreibung',
        ...SHARED,
      });
    });

    it('builds a manifest for each language of the app, with its own description', (): void => {
      const files: Emitted[] = build(resolvedPlugin(APP_ROOT));
      const languages: string[] = fs
        .readdirSync(path.join(APP_ROOT, LOCALES_DIR))
        .filter((file: string) => file.endsWith('.json'))
        .map((file: string) => path.basename(file, '.json'))
        .sort();

      expect(languages).toEqual(['en', 'es', 'pt-BR']);
      expect(files.map((file: Emitted) => file.fileName).sort()).toEqual(
        languages.map((locale: string) => `manifest.${locale}.webmanifest`),
      );
      for (const locale of languages) {
        const file: Emitted | undefined = files.find(
          (f: Emitted) => f.fileName === `manifest.${locale}.webmanifest`,
        );
        const manifest: Manifest = JSON.parse(file?.source ?? '{}') as Manifest;

        expect(manifest.lang).toBe(locale);
        expect(manifest.description).toBe(readDescription(APP_ROOT, locale));
        expect(manifest.description.length).toBeGreaterThan(0);
      }
    });

    it('shares the same id and start_url in every language, so switching languages keeps the same installed app', (): void => {
      const manifests: Manifest[] = build(resolvedPlugin(APP_ROOT)).map(
        (file: Emitted) => JSON.parse(file.source) as Manifest,
      );

      expect(new Set(manifests.map((m: Manifest) => m.id))).toEqual(
        new Set(['./']),
      );
      expect(new Set(manifests.map((m: Manifest) => m.start_url))).toEqual(
        new Set(['./']),
      );
      expect(new Set(manifests.map((m: Manifest) => m.description)).size).toBe(
        manifests.length,
      );
    });

    it('points only to icons that exist in public/', (): void => {
      const [file]: Emitted[] = build(resolvedPlugin(APP_ROOT));
      const manifest: Manifest = JSON.parse(file.source) as Manifest;

      expect(manifest.icons).toHaveLength(5);
      for (const icon of manifest.icons)
        expect(
          fs.existsSync(path.join(APP_ROOT, 'public', icon.src)),
          icon.src,
        ).toBe(true);
    });

    it('uses paths relative to the manifest, so they work under any base', (): void => {
      const [file]: Emitted[] = build(resolvedPlugin(APP_ROOT, '/scanner/'));
      const manifest: Manifest = JSON.parse(file.source) as Manifest;

      expect(manifest.start_url).toBe('./');
      expect(manifest.scope).toBe('./');
      for (const icon of manifest.icons)
        expect(icon.src.startsWith('/'), icon.src).toBe(false);
    });
  });

  describe('dev server', (): void => {
    it('answers a manifest request with the manifest of that language, as application/manifest+json', (): void => {
      const response: DevResponse = request(
        resolvedPlugin(fixture),
        '/manifest.fr-CA.webmanifest',
      );

      expect(response.passed).toBe(false);
      expect(response.headers).toEqual({
        'Content-Type': 'application/manifest+json',
      });
      expect(JSON.parse(response.body ?? '{}')).toEqual({
        lang: 'fr-CA',
        dir: 'ltr',
        description: 'Description française',
        ...SHARED,
      });
    });

    it('serves the same manifest as the build', (): void => {
      const plugin: Plugin = resolvedPlugin(APP_ROOT);
      const built: Emitted | undefined = build(plugin).find(
        (file: Emitted) => file.fileName === 'manifest.es.webmanifest',
      );

      expect(request(plugin, '/manifest.es.webmanifest').body).toBe(
        built?.source,
      );
    });

    it('ignores the query string and the base path of the request', (): void => {
      const plugin: Plugin = resolvedPlugin(fixture, '/scanner/');

      expect(
        JSON.parse(
          request(plugin, '/scanner/manifest.de.webmanifest?v=2').body ?? '{}',
        ),
      ).toMatchObject({ lang: 'de', description: 'Deutsche Beschreibung' });
    });

    it('reads the messages on each request, so edits show up right away', (): void => {
      const plugin: Plugin = resolvedPlugin(fixture);

      expect(
        JSON.parse(request(plugin, '/manifest.de.webmanifest').body ?? '{}'),
      ).toMatchObject({ description: 'Deutsche Beschreibung' });

      fs.writeFileSync(
        path.join(fixture, LOCALES_DIR, 'de.json'),
        messages('Neue Beschreibung'),
      );

      expect(
        JSON.parse(request(plugin, '/manifest.de.webmanifest').body ?? '{}'),
      ).toMatchObject({ description: 'Neue Beschreibung' });
    });

    it.each<[string, string | undefined]>([
      ['a manifest of a language without messages', '/manifest.ja.webmanifest'],
      ['another .webmanifest file', '/site.webmanifest'],
      ['the page', '/'],
      ['a script', '/src/main.tsx'],
      ['a language file', `/src/i18n/locales/${DEFAULT_LOCALE}.json`],
      ['a request without a URL', undefined],
    ])(
      'passes %s on to the next middleware',
      (_: string, url: string | undefined): void => {
        const response: DevResponse = request(resolvedPlugin(fixture), url);

        expect(response.passed).toBe(true);
        expect(response.headers).toEqual({});
        expect(response.body).toBeUndefined();
      },
    );

    it('keeps passing other requests on while a language file is being edited into invalid JSON', (): void => {
      fs.writeFileSync(path.join(fixture, LOCALES_DIR, 'de.json'), '{ "app": ');
      const plugin: Plugin = resolvedPlugin(fixture);

      expect(request(plugin, '/').passed).toBe(true);
      expect(request(plugin, '/src/main.tsx').passed).toBe(true);
      expect((): void => {
        request(plugin, '/manifest.de.webmanifest');
      }).toThrow(SyntaxError);
    });
  });

  describe('index.html', (): void => {
    const INDEX: string =
      '<!doctype html>\n<html>\n  <head>\n    <title>DocScanner</title>\n  </head>\n</html>';

    it(`adds the language of DEFAULT_LOCALE (${DEFAULT_LOCALE}) to <html>`, (): void => {
      const { html }: IndexHtml = transformIndexHtml(
        resolvedPlugin(fixture),
        INDEX,
      );

      expect(html).toBe(
        INDEX.replace('<html>', `<html lang="${DEFAULT_LOCALE}">`),
      );
    });

    it('keeps the other attributes of <html> and changes only the first <html> tag', (): void => {
      const { html }: IndexHtml = transformIndexHtml(
        resolvedPlugin(fixture),
        '<html class="app"><body><pre>&lt;html&gt;</pre><!-- <html> --></body></html>',
      );

      expect(html).toBe(
        `<html lang="${DEFAULT_LOCALE}" class="app"><body><pre>&lt;html&gt;</pre><!-- <html> --></body></html>`,
      );
    });

    it('adds the description of DEFAULT_LOCALE and its manifest to the head', (): void => {
      const { tags }: IndexHtml = transformIndexHtml(
        resolvedPlugin(fixture),
        INDEX,
      );

      expect(tags).toEqual([
        {
          tag: 'meta',
          attrs: { name: 'description', content: 'Default description' },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: {
            rel: 'manifest',
            href: `/manifest.${DEFAULT_LOCALE}.webmanifest`,
          },
          injectTo: 'head',
        },
      ]);
    });

    it('uses the real description of DEFAULT_LOCALE from the app messages', (): void => {
      const { tags }: IndexHtml = transformIndexHtml(
        resolvedPlugin(APP_ROOT),
        INDEX,
      );

      expect(tags[0].attrs).toEqual({
        name: 'description',
        content: readDescription(APP_ROOT, DEFAULT_LOCALE),
      });
    });

    it.each<[string, string]>([
      ['/', `/manifest.${DEFAULT_LOCALE}.webmanifest`],
      ['/scanner/', `/scanner/manifest.${DEFAULT_LOCALE}.webmanifest`],
      ['./', `./manifest.${DEFAULT_LOCALE}.webmanifest`],
    ])(
      'links the manifest under the Vite base %s',
      (base: string, href: string): void => {
        const { tags }: IndexHtml = transformIndexHtml(
          resolvedPlugin(fixture, base),
          INDEX,
        );

        expect(tags[1].attrs).toEqual({ rel: 'manifest', href });
      },
    );

    it('links a manifest that the build emits', (): void => {
      const plugin: Plugin = resolvedPlugin(APP_ROOT);
      const { tags }: IndexHtml = transformIndexHtml(plugin, INDEX);
      const href: unknown = tags[1].attrs?.href;

      expect(
        build(plugin).map((file: Emitted) => `/${file.fileName}`),
      ).toContain(href);
    });

    describe('with another DEFAULT_LOCALE', (): void => {
      afterEach((): void => {
        vi.doUnmock('../src/i18n/locale');
        vi.resetModules();
      });

      it('takes the language, the description and the manifest from DEFAULT_LOCALE alone', async (): Promise<void> => {
        vi.resetModules();
        vi.doMock('../src/i18n/locale', (): { DEFAULT_LOCALE: string } => ({
          DEFAULT_LOCALE: 'de',
        }));
        const { webManifest: withGerman }: typeof import('./webManifest') =
          await import('./webManifest');
        const plugin: Plugin = withGerman();
        callHook(plugin.configResolved, {}, { root: fixture, base: '/' });

        const { html, tags }: IndexHtml = transformIndexHtml(plugin, INDEX);

        expect(html).toBe(INDEX.replace('<html>', '<html lang="de">'));
        expect(tags).toEqual([
          {
            tag: 'meta',
            attrs: { name: 'description', content: 'Deutsche Beschreibung' },
            injectTo: 'head',
          },
          {
            tag: 'link',
            attrs: { rel: 'manifest', href: '/manifest.de.webmanifest' },
            injectTo: 'head',
          },
        ]);
      });
    });
  });
});
