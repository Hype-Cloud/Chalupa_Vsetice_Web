// Základ i18n: texty přes klíče, množná čísla přes Intl.PluralRules, data a ceny přes Intl.
//
// Zatím jen čeština. Další jazyk = nový soubor v messages/ se stejnými klíči (Partial – co chybí,
// zobrazí se česky) a záznam v CATALOGS. Jazyk se později bude volit podle URL (/, /en/, …).
// Měna je parametr formátování (zatím jen CZK); částky přicházejí ze serveru.

import { cs } from './messages/cs.ts';

export const LOCALES = ['cs', 'de', 'en', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'cs';

/** Jazyk → locale pro Intl (formát dat, čísel a množných čísel). */
const INTL_LOCALE: Record<Locale, string> = { cs: 'cs-CZ', de: 'de-DE', en: 'en-GB', uk: 'uk-UA' };

export type Currency = 'CZK';
export const DEFAULT_CURRENCY: Currency = 'CZK';

type PluralForms = { one: string; few?: string; many?: string; other: string };
type Catalog = typeof cs;
export type MessageKey = { [K in keyof Catalog]: Catalog[K] extends string ? K : never }[keyof Catalog];
export type PluralKey = { [K in keyof Catalog]: Catalog[K] extends string ? never : K }[keyof Catalog];
export type Messages = { [K in keyof Catalog]: Catalog[K] extends string ? string : PluralForms };

const CATALOGS: Partial<Record<Locale, Partial<Messages>>> = { cs };

export type Params = Record<string, string | number>;

export interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  /** Množné číslo s parametrem {count} (a případně dalšími). */
  plural: (key: PluralKey, count: number, params?: Params) => string;
  /** ISO datum (YYYY-MM-DD) → lokalizované datum s dnem v týdnu, např. „pá 7. 12. 2030“. */
  formatDate: (date: string) => string;
  /** Celé jednotky měny ze serveru → „28 500 Kč“. */
  formatPrice: (amount: number) => string;
}

const interpolate = (text: string, params: Params = {}) => text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function createI18n(locale: Locale = DEFAULT_LOCALE, options: { currency?: Currency } = {}): I18n {
  const catalog = CATALOGS[locale] ?? {};
  const fallback = cs as Messages;
  const intl = INTL_LOCALE[locale];
  const rules = new Intl.PluralRules(intl);
  const dates = new Intl.DateTimeFormat(intl, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
  const prices = new Intl.NumberFormat(intl, { style: 'currency', currency: options.currency ?? DEFAULT_CURRENCY, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const lookup = <K extends keyof Messages>(key: K): Messages[K] => (catalog[key] ?? fallback[key]) as Messages[K];

  return {
    locale,
    t: (key, params) => interpolate(lookup(key) as string, params),
    plural: (key, count, params) => {
      const forms = lookup(key) as PluralForms;
      const category = rules.select(count) as keyof PluralForms;
      return interpolate(forms[category] ?? forms.other, { count, ...params });
    },
    formatDate: (date) => dates.format(new Date(`${date}T12:00:00Z`)),
    formatPrice: (amount) => prices.format(amount),
  };
}
