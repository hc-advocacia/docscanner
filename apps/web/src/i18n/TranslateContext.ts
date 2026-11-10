import { type Context, createContext } from 'react';

import type { Locale } from './config';
import type { TranslateFunction } from './translate';

export interface TranslateContextValue {
  locale: Locale;
  /** Whether the language is fixed: the user cannot change it, so there is no language picker. */
  fixed: boolean;
  /** Changes the language and remembers the choice. Does nothing when the language is fixed. */
  setLocale(locale: Locale): void;
  /** Translates a key in the current language. */
  t: TranslateFunction;
}

export const TranslateContext: Context<TranslateContextValue | null> =
  createContext<TranslateContextValue | null>(null);
