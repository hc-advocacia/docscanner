import { act, render, screen } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LOCALE, type Locale, MESSAGES } from './config';
import type { TranslateContextValue } from './TranslateContext';
import { TranslateProvider } from './TranslateProvider';
import { useTranslate } from './useTranslate';

const STORAGE_KEY: string = 'docscanify.locale';

/** The manifest link the provider sets for a language, under the base path. */
const manifestHref = (locale: Locale): string =>
  `${import.meta.env.BASE_URL}manifest.${locale}.webmanifest`;

/** Makes the browser report these languages, in this order of preference. */
const browserLanguages = (...languages: string[]): void => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '');
};

/** The head that index.html gets from plugins/webManifest.ts, in the default language. */
const writeHead = (): void => {
  document.documentElement.lang = DEFAULT_LOCALE;
  document.head.innerHTML = [
    `<meta name="description" content="${MESSAGES[DEFAULT_LOCALE].app.description}">`,
    `<link rel="manifest" href="/manifest.${DEFAULT_LOCALE}.webmanifest">`,
  ].join('');
};

/** Content of the description meta, or null when the page has none. */
const description = (): string | null =>
  document.querySelector('meta[name="description"]')?.getAttribute('content') ??
  null;

/** Href of the manifest link, or null when the page has none. */
const manifest = (): string | null =>
  document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null;

/** Every value the provider gives, as the last render saw it. */
let latest: TranslateContextValue | null = null;

/** Shows the current language and a few messages, and offers a button per language. */
function Probe(): JSX.Element {
  const value: TranslateContextValue = useTranslate();
  latest = value;
  return (
    <div>
      <p data-testid="locale">{value.locale}</p>
      <p data-testid="crop">{value.t('app.step.crop')}</p>
      <p data-testid="back">{value.t('common.back')}</p>
      <p data-testid="photos">{value.t('camera.photos', { count: 2 })}</p>
      {(['pt-BR', 'en', 'es'] satisfies Locale[]).map((locale: Locale) => (
        <button
          key={locale}
          type="button"
          onClick={(): void => {
            value.setLocale(locale);
          }}
        >
          {`use ${locale}`}
        </button>
      ))}
    </div>
  );
}

/** Renders the provider around {@link Probe}. */
const renderProvider = (defaultLocale?: Locale, fixed?: boolean): void => {
  render(
    <TranslateProvider defaultLocale={defaultLocale} fixed={fixed}>
      <Probe />
    </TranslateProvider>,
  );
};

/**
 * The value {@link Probe} saw on its last render.
 *
 * @throws When Probe has not rendered yet.
 */
const currentValue = (): TranslateContextValue => {
  if (!latest) throw new Error('Probe has not rendered');
  return latest;
};

describe('TranslateProvider', (): void => {
  beforeEach((): void => {
    latest = null;
    writeHead();
  });

  afterEach((): void => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('lang');
  });

  describe('initial language', (): void => {
    it('starts in the first supported browser language', (): void => {
      browserLanguages('fr-FR', 'es-MX', 'pt-BR');
      renderProvider();

      expect(screen.getByTestId('locale')).toHaveTextContent(/^es$/);
      expect(screen.getByTestId('crop')).toHaveTextContent(/^Recortar$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Volver$/);
      expect(screen.getByTestId('photos')).toHaveTextContent(/^2 fotos$/);
    });

    it('starts in the language the user chose before, over the browser languages', (): void => {
      browserLanguages('es-ES');
      localStorage.setItem(STORAGE_KEY, 'pt-BR');
      renderProvider();

      expect(screen.getByTestId('locale')).toHaveTextContent(/^pt-BR$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Voltar$/);
    });

    it('starts in DEFAULT_LOCALE when no browser language is supported', (): void => {
      browserLanguages('fr-FR', 'de');
      renderProvider();

      expect(screen.getByTestId('locale')).toHaveTextContent(
        new RegExp(`^${DEFAULT_LOCALE}$`),
      );
      expect(screen.getByTestId('back')).toHaveTextContent(
        MESSAGES[DEFAULT_LOCALE].common.back,
      );
    });

    it('starts in the defaultLocale prop when no browser language is supported', (): void => {
      browserLanguages('fr-FR', 'de');
      renderProvider('pt-BR');

      expect(screen.getByTestId('locale')).toHaveTextContent(/^pt-BR$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Voltar$/);
    });

    it('prefers a supported browser language over the defaultLocale prop', (): void => {
      browserLanguages('en-GB');
      renderProvider('pt-BR');

      expect(screen.getByTestId('locale')).toHaveTextContent(/^en$/);
    });

    it('does not store the detected language as a choice', (): void => {
      browserLanguages('es');
      renderProvider();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('page metadata', (): void => {
    it('sets <html lang>, the description and the manifest of the initial language', (): void => {
      browserLanguages('pt-PT');
      renderProvider();

      expect(document.documentElement.lang).toBe('pt-BR');
      expect(description()).toBe(MESSAGES['pt-BR'].app.description);
      expect(manifest()).toBe(manifestHref('pt-BR'));
    });

    it('links the manifest under the base path the app is served from', (): void => {
      vi.stubEnv('BASE_URL', '/scanner/');
      try {
        browserLanguages('es');
        renderProvider();

        expect(manifest()).toBe('/scanner/manifest.es.webmanifest');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('works without the description meta and the manifest link', (): void => {
      document.head.innerHTML = '';
      browserLanguages('es');
      renderProvider();

      expect(document.documentElement.lang).toBe('es');
      expect(document.head.querySelector('meta')).toBeNull();
      expect(document.head.querySelector('link')).toBeNull();
    });

    it('changes only the description meta and the manifest link', (): void => {
      document.head.insertAdjacentHTML(
        'beforeend',
        '<meta name="theme-color" content="#ffffff"><link rel="icon" href="/icon.svg">',
      );
      browserLanguages('es');
      renderProvider();

      expect(
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute('content'),
      ).toBe('#ffffff');
      expect(
        document.querySelector('link[rel="icon"]')?.getAttribute('href'),
      ).toBe('/icon.svg');
    });
  });

  describe('setLocale', (): void => {
    it('switches the messages to the chosen language', async (): Promise<void> => {
      const user: UserEvent = userEvent.setup();
      browserLanguages('en-US');
      renderProvider();

      await user.click(screen.getByRole('button', { name: 'use pt-BR' }));

      expect(screen.getByTestId('locale')).toHaveTextContent(/^pt-BR$/);
      expect(screen.getByTestId('crop')).toHaveTextContent(/^Recortar$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Voltar$/);
      expect(screen.getByTestId('photos')).toHaveTextContent(/^2 fotos$/);

      await user.click(screen.getByRole('button', { name: 'use en' }));

      expect(screen.getByTestId('back')).toHaveTextContent(/^Back$/);
      expect(screen.getByTestId('photos')).toHaveTextContent(/^2 photos$/);
    });

    it('remembers the choice, so the next visit starts in it', async (): Promise<void> => {
      const user: UserEvent = userEvent.setup();
      browserLanguages('en-US');
      renderProvider();

      await user.click(screen.getByRole('button', { name: 'use es' }));

      expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
    });

    it('updates <html lang>, the description and the manifest', async (): Promise<void> => {
      const user: UserEvent = userEvent.setup();
      browserLanguages('en-US');
      renderProvider();

      await user.click(screen.getByRole('button', { name: 'use es' }));

      expect(document.documentElement.lang).toBe('es');
      expect(description()).toBe(MESSAGES.es.app.description);
      expect(manifest()).toBe(manifestHref('es'));

      await user.click(screen.getByRole('button', { name: 'use pt-BR' }));

      expect(document.documentElement.lang).toBe('pt-BR');
      expect(description()).toBe(MESSAGES['pt-BR'].app.description);
      expect(manifest()).toBe(manifestHref('pt-BR'));
    });

    it('keeps the same setLocale function across language changes', (): void => {
      browserLanguages('en-US');
      renderProvider();
      const first: TranslateContextValue = currentValue();

      act((): void => {
        first.setLocale('es');
      });

      const second: TranslateContextValue = currentValue();

      expect(second.locale).toBe('es');
      expect(second.setLocale).toBe(first.setLocale);
      expect(second.t).not.toBe(first.t);
    });
  });

  describe('fixed', (): void => {
    it('is off by default: the language follows the browser and can be changed', (): void => {
      browserLanguages('es-MX');
      renderProvider('pt-BR');

      expect(currentValue().fixed).toBe(false);
      expect(screen.getByTestId('locale')).toHaveTextContent(/^es$/);
    });

    it('always starts in defaultLocale, ignoring the browser languages and the previous choice', (): void => {
      browserLanguages('en-US', 'es');
      localStorage.setItem(STORAGE_KEY, 'es');
      renderProvider('pt-BR', true);

      expect(currentValue().fixed).toBe(true);
      expect(screen.getByTestId('locale')).toHaveTextContent(/^pt-BR$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Voltar$/);
      expect(document.documentElement.lang).toBe('pt-BR');
      expect(description()).toBe(MESSAGES['pt-BR'].app.description);
      expect(manifest()).toBe(manifestHref('pt-BR'));
    });

    it('ignores setLocale and stores no choice', async (): Promise<void> => {
      const user: UserEvent = userEvent.setup();
      browserLanguages('en-US');
      renderProvider('pt-BR', true);

      await user.click(screen.getByRole('button', { name: 'use en' }));

      expect(screen.getByTestId('locale')).toHaveTextContent(/^pt-BR$/);
      expect(screen.getByTestId('back')).toHaveTextContent(/^Voltar$/);
      expect(document.documentElement.lang).toBe('pt-BR');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });
});
