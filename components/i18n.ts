import { createContext, useContext } from 'react';
import { createI18n, DEFAULT_LOCALE, type I18n } from '../lib/i18n/index.ts';

/** Texty a formátování aktuálního jazyka. Bez provideru čeština; jazyk podle URL přidá provider později. */
export const I18nContext = createContext<I18n>(createI18n(DEFAULT_LOCALE));

export const useI18n = () => useContext(I18nContext);
