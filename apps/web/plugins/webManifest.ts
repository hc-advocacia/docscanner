import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import type {
  Connect,
  HtmlTagDescriptor,
  IndexHtmlTransformResult,
  Plugin,
  ResolvedConfig,
  ViteDevServer,
} from 'vite';

import { DEFAULT_LOCALE } from '../src/i18n/locale.ts';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface SharedManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: ManifestIcon[];
}

interface LocaleManifest extends SharedManifest {
  lang: string;
  dir: string;
  description: string;
}

/** The part of a language's messages the plugin reads. */
interface ManifestMessages {
  app: { description: string };
}

/** Every JSON file here is a language and gets its own manifest. */
const LOCALES_DIR: string = 'src/i18n/locales';

/**
 * What every language shares. Paths are relative to the manifest, which sits at the root of the
 * app, so they work with any `base`. `id` and `start_url` are the same in every language: the
 * installed app stays the same app when the language changes.
 */
const SHARED: SharedManifest = {
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

/**
 * File name of a language's manifest; `TranslateProvider` links the one of the current language.
 */
const fileName = (locale: string): string => `manifest.${locale}.webmanifest`;

/**
 * Messages of a language, read from its file under {@link LOCALES_DIR} of the app at `root`.
 * Throws when the file is missing or is not valid JSON.
 */
function readMessages(root: string, locale: string): ManifestMessages {
  return JSON.parse(
    fs.readFileSync(path.resolve(root, LOCALES_DIR, `${locale}.json`), 'utf8'),
  ) as ManifestMessages;
}

/** The manifest of each language, by file name, with the description from its messages. */
function buildManifests(root: string): Map<string, string> {
  const dir: string = path.resolve(root, LOCALES_DIR);
  const manifests: Map<string, string> = new Map<string, string>();
  for (const file of fs
    .readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))) {
    const locale: string = path.basename(file, '.json');
    const messages: ManifestMessages = readMessages(root, locale);
    const manifest: LocaleManifest = {
      lang: locale,
      dir: 'ltr',
      description: messages.app.description,
      ...SHARED,
    };
    manifests.set(fileName(locale), JSON.stringify(manifest, null, 2));
  }
  return manifests;
}

/**
 * Web app manifests, one per language (`manifest.<locale>.webmanifest`), so the installed app
 * shows its description in the user's language. The dev server builds them on each request, so
 * edits to the messages show up right away; the build writes them next to `index.html`.
 *
 * It also gives `index.html` the language, the description and the manifest of
 * {@link DEFAULT_LOCALE}, which is what crawlers, link previews and the first paint see. Once the
 * app starts, `TranslateProvider` switches the three to the user's language.
 */
export function webManifest(): Plugin {
  let root: string = '';
  let base: string = '/';

  return {
    name: 'web-manifest',
    configResolved(config: ResolvedConfig): void {
      root = config.root;
      base = config.base;
    },
    transformIndexHtml(html: string): IndexHtmlTransformResult {
      const { app }: ManifestMessages = readMessages(root, DEFAULT_LOCALE);
      const tags: HtmlTagDescriptor[] = [
        {
          tag: 'meta',
          attrs: { name: 'description', content: app.description },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: {
            rel: 'manifest',
            href: `${base}${fileName(DEFAULT_LOCALE)}`,
          },
          injectTo: 'head',
        },
      ];
      return {
        html: html.replace(/<html\b/, `<html lang="${DEFAULT_LOCALE}"`),
        tags,
      };
    },
    configureServer(server: ViteDevServer): void {
      server.middlewares.use(
        (
          req: Connect.IncomingMessage,
          res: ServerResponse,
          next: Connect.NextFunction,
        ): void => {
          const name: string = path.posix.basename(
            (req.url ?? '').split('?')[0],
          );
          const manifest: string | false | undefined =
            name.endsWith('.webmanifest') && buildManifests(root).get(name);
          if (!manifest) {
            next();
            return;
          }
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(manifest);
        },
      );
    },
    generateBundle(): void {
      for (const [name, source] of buildManifests(root)) {
        this.emitFile({ type: 'asset', fileName: name, source });
      }
    },
  };
}
