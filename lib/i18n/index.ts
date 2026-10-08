// i18n webu: texty přes klíče, množná čísla přes Intl.PluralRules, data a čísla přes Intl.
//
// - Katalogy: messages/<jazyk>.ts, všechny se stejnými klíči jako čeština (kontroluje tsc
//   i test). Chybějící klíč by se zobrazil česky – jen pojistka, v katalozích chybět nemá.
// - Aktuální jazyk volí provider (components/I18nProvider.tsx) podle preference.ts.
// - Jazyk a měna jsou oddělené: jazyk určuje texty a formát, měna je parametr (zatím jen CZK).
//   Částky přicházejí ze serveru (/api/quote); i18n je jen formátuje.

import { cs } from './messages/cs.ts';
import { de } from './messages/de.ts';
import { en } from './messages/en.ts';
import { uk } from './messages/uk.ts';
import type { MessageKey, Messages, PluralForms, PluralKey } from './types.ts';

export type { MessageKey, Messages, PluralForms, PluralKey };

export const LOCALES = ['cs', 'en', 'de', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'cs';

/** Název jazyka v něm samém (přepínač jazyků); nepřekládá se. */
export const LOCALE_NAMES: Record<Locale, string> = { cs: 'Čeština', en: 'English', de: 'Deutsch', uk: 'Українська' };

/** Jazyk → locale pro Intl (formát dat, čísel a množných čísel). */
export const INTL_LOCALE: Record<Locale, string> = { cs: 'cs-CZ', en: 'en-GB', de: 'de-DE', uk: 'uk-UA' };

export type Currency = 'CZK';
export const DEFAULT_CURRENCY: Currency = 'CZK';

export const CATALOGS: Record<Locale, Messages> = { cs, en, de, uk };

/** Krátké datum s dnem v týdnu: čeština číselně (so 7. 12. 2030), ostatní se zkratkou měsíce (Sat 7 Dec 2030). */
const SHORT_DATE: Record<Locale, Intl.DateTimeFormatOptions> = {
  cs: { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' },
  en: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  de: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  uk: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
};

export type Params = Record<string, string | number>;

export interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  /** Množné číslo s parametrem {count} (a případně dalšími). */
  plural: (key: PluralKey, count: number, params?: Params) => string;
  /** ISO datum (YYYY-MM-DD) → krátké datum s dnem v týdnu. */
  formatDate: (date: string) => string;
  /** ISO datum → plné datum pro čtečky obrazovky („sobota 7. prosince 2030“). */
  formatFullDate: (date: string) => string;
  /** Čas (ISO 8601) → den, měsíc a čas v Europe/Prague. */
  formatDateTime: (iso: string) => string;
  /** První den měsíce → „Prosinec 2030“. */
  formatMonth: (monthStart: string) => string;
  /** Rozsah zobrazených měsíců → „říjen – prosinec 2026“ podle jazyka. */
  formatMonthRange: (first: string, last: string) => string;
  /** Zkratky dnů v týdnu, pondělí první. */
  weekdays: () => string[];
  /** Celé jednotky měny ze serveru → „28 500 Kč“ / „CZK 28,500“. */
  formatPrice: (amount: number) => string;
}

const interpolate = (text: string, params: Params = {}) => text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
const asDate = (date: string) => new Date(`${date}T12:00:00Z`);
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function createI18n(locale: Locale = DEFAULT_LOCALE, options: { currency?: Currency; catalogs?: Partial<Record<Locale, Partial<Messages>>> } = {}): I18n {
  const catalog: Partial<Messages> = (options.catalogs ?? CATALOGS)[locale] ?? {};
  const fallback = cs as Messages;
  const intl = INTL_LOCALE[locale];
  const utc = { timeZone: 'UTC' } as const;
  const rules = new Intl.PluralRules(intl);
  const shortDate = new Intl.DateTimeFormat(intl, { ...utc, ...SHORT_DATE[locale] });
  const fullDate = new Intl.DateTimeFormat(intl, { ...utc, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateTime = new Intl.DateTimeFormat(intl, { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const month = new Intl.DateTimeFormat(intl, { ...utc, month: 'long', year: 'numeric' });
  const monthOnly = new Intl.DateTimeFormat(intl, { ...utc, month: 'long' });
  const weekday = new Intl.DateTimeFormat(intl, { ...utc, weekday: 'short' });
  const prices = new Intl.NumberFormat(intl, { style: 'currency', currency: options.currency ?? DEFAULT_CURRENCY, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  /** Chybějící překlad → čeština (pojistka). */
  const lookup = <K extends keyof Messages>(key: K): Messages[K] => (catalog[key] ?? fallback[key]) as Messages[K];

  return {
    locale,
    t: (key, params) => interpolate(lookup(key) as string, params),
    plural: (key, count, params) => {
      const forms = lookup(key) as PluralForms;
      const category = rules.select(count) as keyof PluralForms;
      return interpolate(forms[category] ?? forms.other, { count, ...params });
    },
    formatDate: (date) => shortDate.format(asDate(date)),
    formatFullDate: (date) => fullDate.format(asDate(date)),
    formatDateTime: (iso) => dateTime.format(new Date(iso)),
    formatMonth: (monthStart) => capitalize(month.format(asDate(monthStart))),
    formatMonthRange: (first, last) => {
      if (first === last) return month.format(asDate(first));
      const sameYear = first.slice(0, 4) === last.slice(0, 4);
      return `${(sameYear ? monthOnly : month).format(asDate(first))} – ${month.format(asDate(last))}`;
    },
    // 2024-01-01 je pondělí.
    weekdays: () => Array.from({ length: 7 }, (_, i) => capitalize(weekday.format(new Date(Date.UTC(2024, 0, 1 + i, 12))))),
    formatPrice: (amount) => prices.format(amount),
  };
}
