import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
  test,
} from '@playwright/test';

import { openApp, uploadImages } from '@/test-support/e2e/app';

/** `app.description` in Brazilian Portuguese, in the meta description and the manifest. */
const DESCRIPTION: string =
  'Escaneie documentos, fotografe ou envie imagens, recorte, ajuste e exporte em PDF, PNG ou JPG. Tudo é processado no seu dispositivo.';

/** Labels of the four steps of the top bar. */
const STEPS: string[] = ['Enviar', 'Recortar', 'Ajustar', 'Exportar'];

/**
 * Checks that every text and the page metadata are in Brazilian Portuguese, and that there is no
 * language picker.
 */
async function expectPortuguese(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Fotografe ou envie imagens dos documentos',
    }),
  ).toBeVisible();
  await expect(page.getByTestId('upload-camera')).toHaveText('Fotografar');
  for (let i: number = 0; i < STEPS.length; i++) {
    await expect(page.getByTestId(`step-${String(i)}`)).toHaveText(
      `${String(i + 1)}${STEPS[i]}`,
    );
  }
  await expect(page.getByTestId('language')).toHaveCount(0);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    DESCRIPTION,
  );
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.pt-BR.webmanifest',
  );
}

/** Gives the browser a list of preferred languages, as set in its settings. */
async function preferLanguages(page: Page, tags: string[]): Promise<void> {
  await page.addInitScript((languages: string[]): void => {
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true,
      get: (): string[] => languages,
    });
  }, tags);
}

test.describe('fixed language', (): void => {
  for (const browser of ['en-US', 'es-MX', 'de-DE', 'pt-PT', 'pt-BR']) {
    test.describe(`browser in ${browser}`, (): void => {
      test.use({ locale: browser });

      test('is always in Brazilian Portuguese, with no language picker', async ({
        page,
      }: {
        page: Page;
      }): Promise<void> => {
        await openApp(page);
        await expectPortuguese(page);
      });
    });
  }

  test('ignores the preferred languages of the browser', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await preferLanguages(page, ['es-MX', 'en-US']);
    await openApp(page);
    await expectPortuguese(page);
  });

  test('ignores a language chosen before the language was fixed', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await page.addInitScript((): void => {
      localStorage.setItem('docscanify.locale', 'en');
    });
    await openApp(page);
    await expectPortuguese(page);
  });

  test('the linked manifest is the Brazilian Portuguese one', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);

    const manifest: { lang: string; description: string } = await page.evaluate(
      async (): Promise<{ lang: string; description: string }> => {
        const link: HTMLLinkElement | null =
          document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
        if (!link) throw new Error('No manifest link');
        const response: Response = await fetch(link.href);
        return (await response.json()) as {
          lang: string;
          description: string;
        };
      },
    );
    expect(manifest.lang).toBe('pt-BR');
    expect(manifest.description).toBe(DESCRIPTION);
  });

  test('the texts about the documents are in Brazilian Portuguese', async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await openApp(page);
    await uploadImages(page, ['invoice.jpg', 'receipt.jpg']);

    await expect(
      page.getByRole('heading', { name: 'Você enviou 2 imagens' }),
    ).toBeVisible();
    await expect(page.getByTestId('upload-continue')).toHaveText('Continuar');
    await expect(page.getByTestId('remove-1')).toHaveAccessibleName(
      'Remover documento 2',
    );
  });
});

test.describe('static HTML, before JavaScript runs', (): void => {
  /** The HTML served at `/`, as crawlers and link previews read it. */
  async function staticHtml(
    request: APIRequestContext,
    acceptLanguage: string,
  ): Promise<string> {
    const response: APIResponse = await request.get('/', {
      headers: { 'Accept-Language': acceptLanguage },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    return response.text();
  }

  for (const acceptLanguage of ['en-US', 'pt-BR', 'es-MX']) {
    test(`is in Brazilian Portuguese, the language of the app, even for Accept-Language ${acceptLanguage}`, async ({
      request,
    }: {
      request: APIRequestContext;
    }): Promise<void> => {
      const html: string = await staticHtml(request, acceptLanguage);

      expect(html).toMatch(/<html lang="pt-BR">/);
      const descriptions: string[] = [
        ...html.matchAll(/<meta name="description" content="([^"]*)"/g),
      ].map((match: RegExpExecArray): string => match[1]);
      expect(descriptions).toEqual([DESCRIPTION]);
      const manifests: string[] = [
        ...html.matchAll(/<link rel="manifest" href="([^"]*)"/g),
      ].map((match: RegExpExecArray): string => match[1]);
      expect(manifests).toEqual(['/manifest.pt-BR.webmanifest']);
    });
  }
});
