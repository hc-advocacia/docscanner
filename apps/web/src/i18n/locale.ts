/** Supported languages, as BCP 47 tags. */
export type Locale = 'pt-BR' | 'en' | 'es';

/**
 * Language used when none of the browser languages is supported, and the only one when
 * {@link FIXED_LOCALE} is on. Change it here to configure the app; `TranslateProvider` also
 * accepts a `defaultLocale` prop.
 *
 * This module imports nothing, so `plugins/webManifest.ts` can read it while Vite loads its config.
 */
export const DEFAULT_LOCALE: Locale = 'pt-BR';

/**
 * Whether the app always uses {@link DEFAULT_LOCALE}: the browser languages and any earlier choice
 * are ignored, and the language picker is hidden. Turn it off to let the user choose again.
 */
export const FIXED_LOCALE: boolean = true;
