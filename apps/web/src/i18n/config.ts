import type { Locale } from './locale';
import en from './locales/en.json';
import es from './locales/es.json';
import ptBR from './locales/pt-BR.json';

/** Messages of one language. pt-BR is the reference shape: every language must have its keys. */
export type Messages = typeof ptBR;

export { DEFAULT_LOCALE, FIXED_LOCALE, type Locale } from './locale';

/** Messages of every supported language. Typed as `Messages`, so a missing key fails to compile. */
export const MESSAGES: Record<Locale, Messages> = {
  'pt-BR': ptBR,
  en,
  es,
};

/** Country whose flag represents a language in the picker (ISO 3166-1 alpha-2, lowercase). */
export type FlagCode = 'br' | 'us' | 'es';

/**
 * Supported languages, in the order shown in the language picker: native name, short code, and
 * the flag shown next to the name.
 */
export const LOCALES: {
  locale: Locale;
  name: string;
  short: string;
  flag: FlagCode;
}[] = [
  { locale: 'en', name: 'English', short: 'EN', flag: 'us' },
  { locale: 'es', name: 'Español', short: 'ES', flag: 'es' },
  { locale: 'pt-BR', name: 'Português (Brasil)', short: 'PT', flag: 'br' },
];

/** Whether a value, such as one read from storage, is exactly the tag of a supported language. */
export const isLocale = (value: unknown): value is Locale =>
  LOCALES.some((l: (typeof LOCALES)[number]) => l.locale === value);
