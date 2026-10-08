// Volba jazyka: 1. ?lang= v URL (sdílitelný odkaz), 2. uložená preference (localStorage),
// 3. čeština. Web je jedna staticky předrenderovaná stránka, proto jazyk není v cestě (/en/),
// ale v query parametru – bez změny routingu a buildu.

import { DEFAULT_LOCALE, isLocale, LOCALES, LOCALE_NAMES, type Locale } from './index.ts';

export const LOCALE_PARAM = 'lang';
export const LOCALE_STORAGE_KEY = 'chalupa-vsetice.locale';

/** Podmnožina Storage (localStorage) – kvůli testům a prohlížečům bez úložiště. */
export type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Jazyk z query stringu (`?lang=en`), jinak null. */
export function localeFromSearch(search: string): Locale | null {
  const value = new URLSearchParams(search).get(LOCALE_PARAM)?.toLowerCase();
  return isLocale(value) ? value : null;
}

/** Uložená preference; nedostupné úložiště (soukromý režim, blokované cookies) = null. */
export function readStoredLocale(storage: LocaleStorage | null | undefined): Locale | null {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(storage: LocaleStorage | null | undefined, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Preference je jen pohodlí – bez úložiště se jazyk prostě nezapamatuje.
  }
}

export function resolveLocale(input: { search: string; storage: LocaleStorage | null | undefined }): Locale {
  return localeFromSearch(input.search) ?? readStoredLocale(input.storage) ?? DEFAULT_LOCALE;
}

/**
 * Adresa stránky pro zvolený jazyk: nastaví `?lang=` (čeština bez parametru), ostatní query
 * parametry a kotva zůstávají.
 */
export function urlWithLocale(href: string, locale: Locale): string {
  const url = new URL(href);
  if (locale === DEFAULT_LOCALE) url.searchParams.delete(LOCALE_PARAM);
  else url.searchParams.set(LOCALE_PARAM, locale);
  return url.toString();
}

export interface LanguageOption {
  locale: Locale;
  /** Zkratka na přepínači (CS, EN, DE, UA). */
  label: string;
  /** Název jazyka v něm samém – pro čtečky obrazovky a tooltip. */
  name: string;
  active: boolean;
}

export function languageOptions(current: Locale): LanguageOption[] {
  return LOCALES.map((locale) => ({ locale, label: locale.toUpperCase(), name: LOCALE_NAMES[locale], active: locale === current }));
}
