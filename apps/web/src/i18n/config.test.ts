import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE as DEFAULT_LOCALE_FROM_CONFIG,
  isLocale,
  type Locale,
  LOCALES,
  MESSAGES,
  type Messages,
} from './config';
import { DEFAULT_LOCALE, FIXED_LOCALE } from './locale';
import ptBR from './locales/pt-BR.json';

/** Every JSON file in locales/, by language: the build makes a web app manifest for each one. */
const LOCALE_FILES: Record<string, unknown> = import.meta.glob<unknown>(
  './locales/*.json',
  { eager: true, import: 'default' },
);

/** Language of a locale file path: `./locales/pt-BR.json` → `pt-BR`. */
const languageOfFile = (file: string): string =>
  file.replace('./locales/', '').replace(/\.json$/, '');

/** Whether a value is a plain object, a branch of the message tree; arrays and null are not. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every `Intl.PluralRules` category. */
const PLURAL_CATEGORIES: readonly string[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
];

/** Plural forms are objects whose keys are all plural categories, including `other`. */
const isPluralForms = (value: unknown): value is Record<string, string> =>
  isObject(value) &&
  'other' in value &&
  Object.keys(value).every((key: string) => PLURAL_CATEGORIES.includes(key));

/** Dot-separated paths to every leaf of a message tree, plural forms included. */
const leafPaths = (node: unknown, prefix: string = ''): string[] =>
  isObject(node)
    ? Object.entries(node).flatMap(([key, child]: [string, unknown]) =>
        leafPaths(child, prefix ? `${prefix}.${key}` : key),
      )
    : [prefix];

/** Every message, by key: a string, or the plural forms of a message. */
const messagesByKey = (
  node: unknown,
  prefix: string = '',
): Map<string, string | Record<string, string>> => {
  const result: Map<string, string | Record<string, string>> = new Map<
    string,
    string | Record<string, string>
  >();
  if (typeof node === 'string' || isPluralForms(node)) {
    result.set(prefix, node);
    return result;
  }
  if (isObject(node))
    for (const [key, child] of Object.entries(node))
      for (const [path, message] of messagesByKey(
        child,
        prefix ? `${prefix}.${key}` : key,
      ))
        result.set(path, message);
  return result;
};

/** Names of the `{name}` placeholders of a text. */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match: RegExpExecArray) => match[1]);

/** Names of the placeholders of a message, across all its plural forms. */
const placeholdersOf = (message: string | Record<string, string>): string[] =>
  [
    ...new Set(
      typeof message === 'string'
        ? placeholders(message)
        : Object.values(message).flatMap(placeholders),
    ),
  ].sort();

const SUPPORTED: Locale[] = LOCALES.map(
  (l: (typeof LOCALES)[number]) => l.locale,
);

describe('DEFAULT_LOCALE', (): void => {
  it('is a supported language, with messages', (): void => {
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
    expect(MESSAGES[DEFAULT_LOCALE]).toBeDefined();
  });

  it('is Brazilian Portuguese, the only language of the app, also for crawlers and link previews', (): void => {
    expect(DEFAULT_LOCALE).toBe('pt-BR');
  });

  it('is the same value from locale.ts and config.ts', (): void => {
    expect(DEFAULT_LOCALE_FROM_CONFIG).toBe(DEFAULT_LOCALE);
  });
});

describe('FIXED_LOCALE', (): void => {
  it('is on: the app always uses DEFAULT_LOCALE, with no language picker', (): void => {
    expect(FIXED_LOCALE).toBe(true);
  });
});

describe('LOCALES', (): void => {
  it('lists the languages in the order of the picker, with native name, short code and flag', (): void => {
    expect(LOCALES).toEqual([
      { locale: 'en', name: 'English', short: 'EN', flag: 'us' },
      { locale: 'es', name: 'Español', short: 'ES', flag: 'es' },
      { locale: 'pt-BR', name: 'Português (Brasil)', short: 'PT', flag: 'br' },
    ]);
  });

  it('lists each language once, with a unique short code', (): void => {
    expect(new Set(SUPPORTED).size).toBe(LOCALES.length);
    expect(
      new Set(LOCALES.map((l: (typeof LOCALES)[number]) => l.short)).size,
    ).toBe(LOCALES.length);
  });

  it('has messages for exactly the listed languages', (): void => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...SUPPORTED].sort());
  });

  it('lists every language file of locales/, and no language without a file', (): void => {
    const files: string[] = Object.keys(LOCALE_FILES).map(languageOfFile);

    expect(files.sort()).toEqual([...SUPPORTED].sort());
  });

  it('registers in MESSAGES the content of each language file', (): void => {
    for (const [file, content] of Object.entries(LOCALE_FILES)) {
      const language: string = languageOfFile(file);

      expect(isLocale(language)).toBe(true);
      if (isLocale(language)) expect(MESSAGES[language]).toEqual(content);
    }
  });
});

describe('isLocale', (): void => {
  it.each<Locale>(['pt-BR', 'en', 'es'])(
    'accepts the supported language %s',
    (value: Locale): void => {
      expect(isLocale(value)).toBe(true);
    },
  );

  it.each<unknown>([
    'pt',
    'pt-br',
    'PT-BR',
    'EN',
    'en-US',
    'fr',
    '',
    ' en',
    null,
    undefined,
    42,
    {},
    ['en'],
  ])('rejects %j', (value: unknown): void => {
    expect(isLocale(value)).toBe(false);
  });
});

describe('locale messages', (): void => {
  const reference: string[] = leafPaths(ptBR).sort();
  const referenceMessages: Map<string, string | Record<string, string>> =
    messagesByKey(ptBR);

  it('pt-BR, the reference, has messages', (): void => {
    expect(reference.length).toBeGreaterThan(50);
    expect(reference).toContain('app.description');
    expect(reference).toContain('upload.filledTitle.one');
    expect(reference).toContain('upload.filledTitle.other');
  });

  it.each<Locale>(SUPPORTED)(
    '%s has exactly the keys of pt-BR.json, plural forms included',
    (locale: Locale): void => {
      expect(leafPaths(MESSAGES[locale]).sort()).toEqual(reference);
    },
  );

  it.each<Locale>(SUPPORTED)(
    '%s has only non-empty texts',
    (locale: Locale): void => {
      const leaves: Map<string, string | Record<string, string>> =
        messagesByKey(MESSAGES[locale]);
      const empty: string[] = [];
      for (const [key, message] of leaves)
        for (const text of typeof message === 'string'
          ? [message]
          : Object.values(message))
          if (text.trim() === '') empty.push(key);

      expect(leaves.size).toBe(referenceMessages.size);
      expect(empty).toEqual([]);
    },
  );

  it.each<Locale>(SUPPORTED)(
    '%s uses only plural categories of its own language, always with "other"',
    (locale: Locale): void => {
      const categories: string[] = new Intl.PluralRules(
        locale,
      ).resolvedOptions().pluralCategories;
      for (const [key, message] of messagesByKey(MESSAGES[locale])) {
        if (typeof message === 'string') continue;

        expect(Object.keys(message), key).toContain('other');
        for (const category of Object.keys(message))
          expect(categories, `${key}.${category}`).toContain(category);
      }
    },
  );

  it.each<Locale>(SUPPORTED)(
    '%s uses the same placeholders as pt-BR.json in each message',
    (locale: Locale): void => {
      const messages: Map<string, string | Record<string, string>> =
        messagesByKey(MESSAGES[locale] satisfies Messages);
      for (const [key, message] of referenceMessages) {
        const translated: string | Record<string, string> | undefined =
          messages.get(key);

        expect(translated, key).toBeDefined();
        if (translated === undefined) continue;

        expect(placeholdersOf(translated), key).toEqual(
          placeholdersOf(message),
        );
      }
    },
  );

  it.each<Locale>(SUPPORTED)(
    '%s has a {count} placeholder in the "other" form of every plural message',
    (locale: Locale): void => {
      for (const [key, message] of messagesByKey(MESSAGES[locale]))
        if (typeof message !== 'string')
          expect(placeholders(message.other), key).toContain('count');
    },
  );
});
