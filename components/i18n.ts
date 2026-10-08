import { createContext, useContext } from 'react';
import { createI18n, DEFAULT_LOCALE, type I18n, type Locale } from '../lib/i18n/index.ts';

/** Texty a formátování aktuálního jazyka (I18nProvider). Bez provideru čeština. */
export const I18nContext = createContext<I18n>(createI18n(DEFAULT_LOCALE));

/** Změna jazyka (I18nProvider). */
export const SetLocaleContext = createContext<(locale: Locale) => void>(() => undefined);

export const useI18n = () => useContext(I18nContext);
export const useSetLocale = () => useContext(SetLocaleContext);
