import { PRICE_PER_NIGHT } from '../lib/booking/rules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGS, createI18n, DEFAULT_LOCALE, INTL_LOCALE, isLocale, LOCALES, type Locale, type Messages, type PluralForms } from '../lib/i18n/index.ts';
import { cs } from '../lib/i18n/messages/cs.ts';
import { en } from '../lib/i18n/messages/en.ts';
import { languageOptions, LOCALE_STORAGE_KEY, localeFromSearch, readStoredLocale, resolveLocale, storeLocale, urlWithLocale, type LocaleStorage } from '../lib/i18n/preference.ts';
import { DAY_STATUS_KEYS, STAY_ERROR_KEYS } from '../components/booking/stayErrors.ts';
import { quoteView } from '../components/booking/quoteView.ts';
import type { QuoteRequest } from '../components/booking/quote.ts';

// i18n celého frontendu: úplnost katalogů (cs, en, de, ua), fallback, volba a persistence jazyka,
// množná čísla, data a CZK v každém jazyce, kalendář a absence pevných textů v komponentách.

const ROOT = new URL('..', import.meta.url).pathname;
const plain = (text: string) => text.replace(/[  ]/g, ' ');
const csKeys = Object.keys(cs).sort();
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** Klíče, které jsou záměrně stejné ve všech jazycích (název chalupy). */
const SAME_IN_ALL = new Set(['brand.name', 'brand.place']);
/** Slova, která jsou v daném jazyce stejná jako česky (ne nepřeložený text). */
const SAME_AS_CZECH = new Set(['de:reservation.form.phone']);

// --- typová kontrola katalogů (tsc --noEmit; za běhu nic nedělá) ---
const { 'meta.title': _omitted, ...withoutTitle } = en;
// @ts-expect-error – katalogu chybí klíč
const missingKey: Messages = withoutTitle;
// @ts-expect-error – katalog má klíč, který čeština nezná
const extraKey = { ...en, 'nav.unknown': 'x' } satisfies Messages;
void missingKey;
void extraKey;

test('podporované jazyky: cs, en, de, ua; výchozí čeština', () => {
  assert.deepEqual([...LOCALES], ['cs', 'en', 'de', 'ua']);
  assert.equal(DEFAULT_LOCALE, 'cs');
  assert.ok(LOCALES.every(isLocale));
  assert.ok(!isLocale('sk') && !isLocale('EN') && !isLocale(undefined) && !isLocale(null));
});

test('každý katalog má přesně klíče českého katalogu, neprázdné hodnoty a stejné parametry', () => {
  for (const locale of LOCALES) {
    const catalog = CATALOGS[locale] as Record<string, string | PluralForms>;
    assert.deepEqual(Object.keys(catalog).sort(), csKeys, locale);
    for (const key of csKeys) {
      const value = catalog[key];
      const reference = (cs as Record<string, string | PluralForms>)[key];
      if (typeof reference === 'string') {
        assert.equal(typeof value, 'string', `${locale} ${key}`);
        assert.ok((value as string).trim().length > 0, `${locale} ${key} prázdné`);
        assert.deepEqual(placeholders(value as string), placeholders(reference), `${locale} ${key}: parametry`);
      } else {
        assert.equal(typeof value, 'object', `${locale} ${key}`);
      }
    }
  }
});

test('katalogy en, de, ua jsou skutečně přeložené (žádný český text) a bez HTML', () => {
  for (const locale of ['en', 'de', 'ua'] as const) {
    for (const key of csKeys) {
      const value = (CATALOGS[locale] as Record<string, unknown>)[key];
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (!SAME_IN_ALL.has(key) && !SAME_AS_CZECH.has(`${locale}:${key}`)) assert.notDeepEqual(value, (cs as Record<string, unknown>)[key], `${locale} ${key} je stejné jako česky`);
      assert.ok(!/[ěščřůňťď]/i.test(text.replace(/VŠETICE|Všetice|e-chalupy\.cz|Čeština/g, '')), `${locale} ${key}: český text`);
    }
  }
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(CATALOGS[locale])) {
      assert.ok(!/<\/?[a-z][^>]*>/i.test(JSON.stringify(value)), `${locale} ${key}: HTML v překladu`);
    }
  }
});

test('množná čísla: každý jazyk má všechny kategorie Intl.PluralRules', () => {
  for (const locale of LOCALES) {
    const categories = new Intl.PluralRules(INTL_LOCALE[locale]).resolvedOptions().pluralCategories;
    for (const [key, value] of Object.entries(CATALOGS[locale])) {
      if (typeof value === 'string') continue;
      for (const category of categories) assert.ok(category in value, `${locale} ${key}: chybí tvar ${category}`);
      for (const text of Object.values(value)) assert.match(text as string, /\{count\}/, `${locale} ${key}`);
    }
  }
  const expected: Record<Locale, { nights: string[]; guests: string[] }> = {
    cs: { nights: ['1 noc', '2 noci', '4 noci', '5 nocí', '21 nocí', '30 nocí'], guests: ['1 host', '2 hosté', '4 hosté', '5 hostů', '7 hostů'] },
    en: { nights: ['1 night', '2 nights', '4 nights', '5 nights', '21 nights', '30 nights'], guests: ['1 guest', '2 guests', '4 guests', '5 guests', '7 guests'] },
    de: { nights: ['1 Nacht', '2 Nächte', '4 Nächte', '5 Nächte', '21 Nächte', '30 Nächte'], guests: ['1 Gast', '2 Gäste', '4 Gäste', '5 Gäste', '7 Gäste'] },
    ua: { nights: ['1 ніч', '2 ночі', '4 ночі', '5 ночей', '21 ніч', '30 ночей'], guests: ['1 гість', '2 гості', '4 гості', '5 гостей', '7 гостей'] },
  };
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    assert.deepEqual([1, 2, 4, 5, 21, 30].map((n) => i18n.plural('booking.nights', n)), expected[locale].nights, locale);
    assert.deepEqual([1, 2, 4, 5, 7].map((n) => i18n.plural('booking.guests', n)), expected[locale].guests, locale);
  }
});

test('datum v každém jazyce (Intl.DateTimeFormat), interně ISO', () => {
  const expected: Record<Locale, [string, string, string]> = {
    cs: ['so 7. 12. 2030', 'sobota 7. prosince 2030', '8. 10. 22:06'],
    en: ['Sat, 7 Dec 2030', 'Saturday, 7 December 2030', '8 Oct, 22:06'],
    de: ['Sa., 7. Dez. 2030', 'Samstag, 7. Dezember 2030', '8.10., 22:06'],
    ua: ['сб, 7 груд. 2030 р.', 'субота, 7 грудня 2030 р.', '08.10, 22:06'],
  };
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    assert.deepEqual([i18n.formatDate('2030-12-07'), i18n.formatFullDate('2030-12-07'), i18n.formatDateTime('2026-10-08T20:06:15Z')].map(plain), expected[locale], locale);
  }
});

test('cena: vždy CZK, formát podle jazyka – jazyk neurčuje měnu (en ani de nejsou EUR)', () => {
  const expected: Record<Locale, string> = { cs: '28 500 Kč', en: 'CZK 28,500', de: '28.500 CZK', ua: '28 500 CZK' };
  for (const locale of LOCALES) {
    const formatted = plain(createI18n(locale).formatPrice(28500));
    assert.equal(formatted, expected[locale], locale);
    assert.ok(!/€|EUR/.test(formatted), locale);
  }
});

test('kalendář: dny v týdnu, měsíce a rozsahy přes Intl v každém jazyce', () => {
  const expected: Record<Locale, { weekdays: string; month: string; sameYear: string; twoYears: string }> = {
    cs: { weekdays: 'Po Út St Čt Pá So Ne', month: 'Listopad 2026', sameYear: 'listopad – prosinec 2026', twoYears: 'prosinec 2026 – únor 2027' },
    en: { weekdays: 'Mon Tue Wed Thu Fri Sat Sun', month: 'November 2026', sameYear: 'November – December 2026', twoYears: 'December 2026 – February 2027' },
    de: { weekdays: 'Mo Di Mi Do Fr Sa So', month: 'November 2026', sameYear: 'November – Dezember 2026', twoYears: 'Dezember 2026 – Februar 2027' },
    ua: { weekdays: 'Пн Вт Ср Чт Пт Сб Нд', month: 'Листопад 2026 р.', sameYear: 'листопад – грудень 2026 р.', twoYears: 'грудень 2026 р. – лютий 2027 р.' },
  };
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    assert.deepEqual(
      {
        weekdays: i18n.weekdays().join(' '),
        month: plain(i18n.formatMonth('2026-11-01')),
        sameYear: plain(i18n.formatMonthRange('2026-11-01', '2026-12-01')),
        twoYears: plain(i18n.formatMonthRange('2026-12-01', '2027-02-01')),
      },
      expected[locale],
      locale,
    );
  }
  const en = createI18n('en');
  assert.deepEqual(
    ['calendar.legend.free', 'calendar.legend.busy', 'calendar.legend.changeover', 'calendar.legend.selected', 'calendar.legend.today', 'calendar.previousMonths', 'calendar.nextMonths'].map((k) => en.t(k as 'calendar.legend.free')),
    ['Available', 'Booked', 'Other guests’ arrival / departure', 'Your stay', 'Today', 'Previous months', 'Next months'],
  );
});

test('hlášky výběru termínu a stavy dnů: technický kód → klíč, přeloženo ve všech jazycích', () => {
  assert.deepEqual(Object.keys(STAY_ERROR_KEYS).sort(), ['arrival-busy', 'no-arrival', 'order', 'past', 'range-busy', 'unknown']);
  assert.deepEqual(Object.keys(DAY_STATUS_KEYS).sort(), ['busy', 'checkin', 'checkout', 'free', 'past', 'unknown']);
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    for (const key of [...Object.values(STAY_ERROR_KEYS), ...Object.values(DAY_STATUS_KEYS)]) {
      assert.equal(i18n.t(key), CATALOGS[locale][key], `${locale} ${key}`);
    }
  }
  assert.equal(createI18n('de').t(STAY_ERROR_KEYS['range-busy']), 'Der gewählte Aufenthalt überschneidet sich mit belegten Tagen. Bitte wählen Sie eine frühere Abreise oder eine andere Anreise.');
  assert.equal(createI18n('cs').t(STAY_ERROR_KEYS.order), 'Odjezd musí být alespoň den po příjezdu.');
});

test('rezervační panel: stejný stav nabídky se po přepnutí jazyka zobrazí v novém jazyce', () => {
  const request: QuoteRequest = { arrivalDate: '2030-12-29', departureDate: '2031-01-02', guests: 2 };
  const exact = { status: 'ready' as const, request, quote: { arrivalDate: request.arrivalDate, departureDate: request.departureDate, nights: 4, pricingMode: 'exact-stay' as const, subtotalCzk: 29900, discount: null, totalCzk: 29900, nightlyPrices: [] } };
  const discounted = {
    status: 'ready' as const,
    request,
    quote: { ...exact.quote, pricingMode: 'nightly' as const, subtotalCzk: 21000, totalCzk: 19950, discount: { type: 'length' as const, minNights: 7, percent: 5, amountCzk: 1050 } },
  };
  const expected: Record<Locale, { total: string; forStay: string; exact: string; discount: string; loading: string; error: string }> = {
    cs: { total: '29 900 Kč', forStay: 'za 4 noci', exact: 'Pevná cena pro tento termín', discount: 'Sleva 5 % (pobyt min. 7 nocí)', loading: 'Počítáme cenu…', error: 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.' },
    en: { total: 'CZK 29,900', forStay: 'for 4 nights', exact: 'Fixed price for these dates', discount: 'Discount 5% (stays of 7 nights or more)', loading: 'Calculating the price…', error: 'The price can’t be calculated right now. Please try again shortly.' },
    de: { total: '29.900 CZK', forStay: 'für 4 Nächte', exact: 'Festpreis für diesen Termin', discount: 'Rabatt 5 % (Aufenthalt mind. 7 Nächte)', loading: 'Preis wird berechnet…', error: 'Der Preis kann gerade nicht berechnet werden. Bitte versuchen Sie es gleich noch einmal.' },
    ua: { total: '29 900 CZK', forStay: 'за 4 ночі', exact: 'Фіксована ціна на ці дати', discount: 'Знижка 5 % (перебування мінімум 7 ночей)', loading: 'Розраховуємо ціну…', error: 'Зараз неможливо розрахувати ціну. Спробуйте, будь ласка, трохи пізніше.' },
  };
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const view = quoteView(exact, i18n);
    const withDiscount = quoteView(discounted, i18n);
    const loading = quoteView({ status: 'loading', request }, i18n);
    const error = quoteView({ status: 'error', request, error: { kind: 'server', status: 503, code: 'pricing-unavailable' } }, i18n);
    assert.ok(view.kind === 'ready' && withDiscount.kind === 'ready' && loading.kind === 'loading' && error.kind === 'error');
    assert.deepEqual(
      { total: plain(view.total), forStay: view.forStay, exact: view.exactStay?.label, discount: withDiscount.discount?.label, loading: loading.label, error: error.message },
      expected[locale],
      locale,
    );
  }
});

test('fallback: chybějící překlad se zobrazí česky (pojistka), parametry zůstanou', () => {
  const partial = createI18n('en', { catalogs: { en: { 'nav.about': 'The cottage' } } });
  assert.equal(partial.t('nav.about'), 'The cottage');
  assert.equal(partial.t('nav.pricing'), 'Ceník');
  assert.equal(partial.t('hero.capacity', { capacity: 7 }), 'Až 7 hostů');
  assert.equal(partial.plural('booking.nights', 5), '5 nocí');
  // Formát i množná čísla se řídí jazykem i při českém textu.
  assert.equal(plain(partial.formatPrice(1000)), 'CZK 1,000');
});

// --- volba a persistence jazyka ---

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: LocaleStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  return { storage, data };
}
const brokenStorage: LocaleStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

test('volba jazyka: ?lang= v URL → uložená preference → čeština', () => {
  const { storage } = memoryStorage({ [LOCALE_STORAGE_KEY]: 'de' });
  assert.equal(resolveLocale({ search: '?lang=en', storage }), 'en', 'URL má přednost');
  assert.equal(resolveLocale({ search: '?lang=UA', storage }), 'ua');
  assert.equal(resolveLocale({ search: '?lang=sk', storage }), 'de', 'neplatný jazyk v URL → preference');
  assert.equal(resolveLocale({ search: '', storage }), 'de');
  assert.equal(resolveLocale({ search: '?utm=x', storage: memoryStorage().storage }), 'cs');
  assert.equal(resolveLocale({ search: '', storage: memoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' }).storage }), 'cs');
  assert.equal(resolveLocale({ search: '', storage: null }), 'cs');
  assert.equal(resolveLocale({ search: '', storage: brokenStorage }), 'cs', 'nedostupné úložiště');
  assert.equal(localeFromSearch('?a=1&lang=de'), 'de');
  assert.equal(localeFromSearch(''), null);
});

test('persistence: přepnutí jazyka se uloží a při další návštěvě obnoví; chyba úložiště nevadí', () => {
  const { storage, data } = memoryStorage();
  storeLocale(storage, 'ua');
  assert.equal(data.get(LOCALE_STORAGE_KEY), 'ua');
  assert.equal(readStoredLocale(storage), 'ua');
  assert.equal(resolveLocale({ search: '', storage }), 'ua', 'další návštěva bez ?lang');
  storeLocale(storage, 'cs');
  assert.equal(resolveLocale({ search: '', storage }), 'cs');
  assert.doesNotThrow(() => storeLocale(brokenStorage, 'en'));
  assert.equal(readStoredLocale(brokenStorage), null);
});

test('adresa po přepnutí: ?lang= pro en/de/ua, čeština bez parametru; ostatní parametry a kotva zůstanou', () => {
  assert.equal(urlWithLocale('https://chalupavsetice.cz/', 'en'), 'https://chalupavsetice.cz/?lang=en');
  assert.equal(urlWithLocale('https://chalupavsetice.cz/?lang=en#terminy', 'de'), 'https://chalupavsetice.cz/?lang=de#terminy');
  assert.equal(urlWithLocale('https://chalupavsetice.cz/?utm=x&lang=ua#cenik', 'cs'), 'https://chalupavsetice.cz/?utm=x#cenik');
});

test('přepínač jazyků: CS EN DE UA, právě jeden aktivní, názvy jazyků (ne vlajky)', () => {
  for (const current of LOCALES) {
    const options = languageOptions(current);
    assert.deepEqual(options.map((o) => o.label), ['CS', 'EN', 'DE', 'UA']);
    assert.deepEqual(options.map((o) => o.name), ['Čeština', 'English', 'Deutsch', 'Українська']);
    assert.deepEqual(options.filter((o) => o.active).map((o) => o.locale), [current]);
  }
  const switcher = readFileSync(join(ROOT, 'components/LanguageSwitcher.tsx'), 'utf8');
  assert.match(switcher, /<button/);
  assert.match(switcher, /aria-pressed=\{option\.active\}/);
  assert.match(switcher, /type="button"/);
  assert.ok(!/flag|🇨🇿|🇬🇧|🇩🇪|🇺🇦/i.test(switcher));
});

test('přepnutí jazyka: všechny texty se změní a žádný přeložený jazyk nevrací češtinu', () => {
  const texts = (locale: Locale) => createI18n(locale);
  for (const key of ['nav.about', 'hero.titleLine1', 'calendar.legend.toggle', 'booking.panel.inquiry', 'pricing.rent.value', 'footer.tagline'] as const) {
    const values = LOCALES.map((l) => texts(l).t(key));
    assert.equal(new Set(values).size, 4, `${key}: ${values.join(' | ')}`);
  }
});

// --- žádné pevné texty v komponentách ---

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const frontendFiles = () => [...sourceFiles(join(ROOT, 'components')), ...sourceFiles(join(ROOT, 'app'))];

test('komponenty a stránka nemají pevné české texty ani textové aria-label/alt/title', () => {
  const files = frontendFiles();
  assert.ok(files.some((f) => f.endsWith('page.tsx')) && files.some((f) => f.endsWith('AvailabilityCalendar.tsx')));
  for (const file of files) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    assert.ok(!/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ]/.test(code), `${file}: český text v kódu`);
    assert.ok(!/\b(aria-label|alt|title|placeholder)="[^"]*[A-Za-z]/.test(code), `${file}: pevný text v atributu`);
  }
  assert.ok(!existsSync(join(ROOT, 'components/booking/format.ts')), 'format.ts s českými tabulkami je odstraněný');
  for (const file of files) assert.ok(!/STAY_ERRORS|WEEKDAYS|DAY_STATUS\b/.test(readFileSync(file, 'utf8')), file);
});

test('žádná pevná cena (3 000 / 2 990 Kč) v UI ani v katalozích; orientační cena noci jen ze serverové konstanty', () => {
  for (const file of frontendFiles()) {
    const code = readFileSync(file, 'utf8');
    assert.ok(!/(3[\s ]?000|2[\s ]?990)\s*Kč|Kč\s*\/\s*noc/.test(code), file);
  }
  for (const locale of LOCALES) {
    const text = JSON.stringify(CATALOGS[locale]);
    assert.ok(!/3[\s .,]?000|2[\s .,]?990/.test(text), `${locale}: pevná částka v katalogu`);
  }
  // Před výběrem termínu: „běžně … / noc“ s cenou z PRICE_PER_NIGHT (výchozí cena serveru).
  const panel = readFileSync(join(ROOT, 'components/booking/BookingPanel.tsx'), 'utf8');
  assert.match(panel, /t\('booking\.panel\.priceStandard', \{ price: formatPrice\(PRICE_PER_NIGHT\) \}\)/);
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    assert.ok(i18n.t('booking.panel.priceStandard', { price: i18n.formatPrice(PRICE_PER_NIGHT) }).includes(i18n.formatPrice(PRICE_PER_NIGHT)), locale);
  }
  // Typografie: „Běžně 2 990 Kč / noc“ (mezera tisíců, mezera před Kč, lomítko s mezerami).
  assert.equal(PRICE_PER_NIGHT, 2990);
  assert.equal(createI18n('cs').t('booking.panel.priceStandard', { price: createI18n('cs').formatPrice(PRICE_PER_NIGHT) }).replace(/[\u00a0\u202f]/g, ' '), 'Běžně 2 990 Kč / noc');
  assert.equal(createI18n('cs').t('pricing.rent.value'), 'Cena podle zvoleného termínu');
  assert.equal(createI18n('en').t('pricing.rent.value'), 'Price depends on your dates');
});
