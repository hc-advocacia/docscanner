import type { JSX } from 'react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { DEFAULT_LOCALE, type Locale, MESSAGES } from './config';
import { detectLocale, storeLocale } from './detectLocale';
import { createTranslate } from './translate';
import {
  TranslateContext,
  type TranslateContextValue,
} from './TranslateContext';

interface Props {
  children: ReactNode;
  /** Language used when no browser language is supported. Defaults to `DEFAULT_LOCALE`. */
  defaultLocale?: Locale;
  /**
   * Always uses `defaultLocale`, ignoring the browser languages and the user's previous choice,
   * and ignores `setLocale`. The app passes `FIXED_LOCALE`.
   */
  fixed?: boolean;
}

/**
 * Provides the current language and its translate function to the app. The language starts as
 * the user's previous choice or the best browser match, unless it is `fixed`. `<html lang>`, the
 * page description, and the app manifest follow it.
 */
export function TranslateProvider({
  children,
  defaultLocale = DEFAULT_LOCALE,
  fixed = false,
}: Props): JSX.Element {
  const [chosen, setChosen] = useState<Locale>(() =>
    fixed ? defaultLocale : detectLocale(defaultLocale),
  );
  const locale: Locale = fixed ? defaultLocale : chosen;

  const setLocale: (next: Locale) => void = useCallback(
    (next: Locale) => {
      if (fixed) return;
      storeLocale(next);
      setChosen(next);
    },
    [fixed],
  );

  const value: TranslateContextValue = useMemo(
    () => ({
      locale,
      fixed,
      setLocale,
      t: createTranslate(locale, MESSAGES[locale], MESSAGES[defaultLocale]),
    }),
    [locale, fixed, setLocale, defaultLocale],
  );

  // The page language, its description, and the app manifest follow the current language. The
  // manifests are built per language by `plugins/webManifest.ts`.
  useEffect(() => {
    document.documentElement.lang = locale;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', value.t('app.description'));
    const manifest: HTMLLinkElement | null =
      document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifest)
      manifest.href = `${import.meta.env.BASE_URL}manifest.${locale}.webmanifest`;
  }, [locale, value]);

  return (
    <TranslateContext.Provider value={value}>
      {children}
    </TranslateContext.Provider>
  );
}
