import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createQuoteLoader, fetchQuote, IDLE_QUOTE, quoteRequestFor, type QuoteRequest, type QuoteResult, type QuoteState } from '../components/booking/quote.ts';
import { quoteView } from '../components/booking/quoteView.ts';
import { createI18n, isLocale, LOCALES } from '../lib/i18n/index.ts';
import { handleQuote } from '../worker/booking/quote.ts';
import { createTestDatabase } from './d1.ts';

// Frontend rezervační sekce: cena jen z /api/quote, ochrana proti souběhu, zobrazení a i18n.
// Kontrakt se ověřuje proti skutečnému handleQuote nad lokální D1. Jen smyšlené údaje.
const NOW = new Date('2030-01-10T10:00:00Z');
const cs = createI18n('cs');
/** Intl používá nezlomitelné mezery – pro čitelné porovnání je nahradíme obyčejnými. */
const plain = (text: string) => text.replace(/[  ]/g, ' ');

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(() => t.db.batch([t.db.prepare('DELETE FROM daily_prices'), t.db.prepare('DELETE FROM length_discounts'), t.db.prepare('DELETE FROM stay_prices')]));

/** Fetch, který posílá požadavky na skutečný handler /api/quote (stejně jako v prohlížeči). */
const backendFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  handleQuote(new Request(new URL(String(input), 'https://chalupa.test.invalid'), init), { DB: t.db }, { now: () => NOW, log: () => undefined })) as typeof fetch;

const request = (arrivalDate: string, departureDate: string, guests = 2): QuoteRequest => ({ arrivalDate, departureDate, guests });
const live = () => new AbortController().signal;

// --- kontrakt s backendem ---

test('validní nightly nabídka ze skutečného /api/quote → cena, noci, bez slevy', async () => {
  const result = await fetchQuote(request('2030-02-01', '2030-02-04'), live(), backendFetch);
  assert.ok(result.ok && 'quote' in result);
  assert.equal(result.quote.pricingMode, 'nightly');
  assert.equal(result.quote.totalCzk, 9000);
  const view = quoteView({ status: 'ready', request: request('2030-02-01', '2030-02-04'), quote: result.quote }, cs);
  assert.ok(view.kind === 'ready');
  assert.equal(plain(view.total), '9 000 Kč');
  assert.equal(view.forStay, 'za 3 noci');
  assert.equal(view.exactStay, null);
  assert.equal(view.discount, null);
});

test('nightly nabídka se slevou → rozpis jen z hodnot serveru', async () => {
  await t.db.prepare('INSERT INTO length_discounts (min_nights, discount_percent) VALUES (7, 5)').run();
  await t.db.prepare(`INSERT INTO daily_prices (date, price_czk) VALUES ('2030-03-02', 4333)`).run();
  const req = request('2030-03-01', '2030-03-08');
  const result = await fetchQuote(req, live(), backendFetch);
  assert.ok(result.ok && 'quote' in result);
  const view = quoteView({ status: 'ready', request: req, quote: result.quote }, cs);
  assert.ok(view.kind === 'ready');
  // Server: 6 × 3 000 + 4 333 = 22 333; sleva 5 % = 1 116 → 21 217 Kč.
  assert.equal(plain(view.total), '21 217 Kč');
  assert.deepEqual(view.discount && { ...view.discount, subtotal: plain(view.discount.subtotal), amount: plain(view.discount.amount) }, {
    subtotalLabel: 'Cena za noci',
    subtotal: '22 333 Kč',
    label: 'Sleva 5 % (pobyt od 7 nocí)',
    amount: '−1 116 Kč',
  });
});

test('validní exact-stay nabídka → pevná cena pro tento termín, bez slevy a rozpisu', async () => {
  await t.db.prepare(`INSERT INTO stay_prices (arrival_date, departure_date, total_czk) VALUES ('2030-12-29', '2031-01-02', 29900)`).run();
  await t.db.prepare('INSERT INTO length_discounts (min_nights, discount_percent) VALUES (2, 10)').run();
  const req = request('2030-12-29', '2031-01-02', 6);
  const result = await fetchQuote(req, live(), backendFetch);
  assert.ok(result.ok && 'quote' in result);
  assert.equal(result.quote.pricingMode, 'exact-stay');
  const view = quoteView({ status: 'ready', request: req, quote: result.quote }, cs);
  assert.ok(view.kind === 'ready');
  assert.equal(plain(view.total), '29 900 Kč');
  assert.equal(view.forStay, 'za 4 noci');
  assert.deepEqual(view.exactStay, { label: 'Pevná cena pro tento termín', hint: 'Platí pro přesně zvolený příjezd a odjezd.' });
  assert.equal(view.discount, null);
  // O den jiný odjezd → běžná cena po nocích (pravidlo se ignoruje).
  const other = await fetchQuote(request('2030-12-29', '2031-01-03'), live(), backendFetch);
  assert.ok(other.ok && 'quote' in other);
  assert.equal(other.quote.pricingMode, 'nightly');
});

test('422 ze skutečného backendu → srozumitelná inline hláška podle pole, bez technického kódu', async () => {
  const cases: [QuoteRequest, string][] = [
    [request('2030-02-01', '2030-03-05'), 'Pobyt může trvat 1–30 nocí. Upravte prosím datum odjezdu.'],
    [request('2031-02-01', '2031-02-03'), 'Pro zvolené datum příjezdu nelze cenu spočítat. Příjezd je možný nejdříve dnes a nejpozději rok dopředu.'],
    [request('2030-02-01', '2030-02-03', 9), 'Počet hostů musí být 1–7.'],
  ];
  for (const [req, message] of cases) {
    const result = await fetchQuote(req, live(), backendFetch);
    assert.ok(!result.ok && 'error' in result, JSON.stringify(req));
    assert.equal(result.error.kind, 'invalid');
    const view = quoteView({ status: 'error', request: req, error: result.error }, cs);
    assert.deepEqual(view, { kind: 'error', message, retryable: false, retryLabel: 'Zkusit znovu' });
  }
});

test('chyba serveru a sítě → obecná hláška s „Zkusit znovu“; neplatná odpověď se nezobrazí jako cena', async () => {
  const respond = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const req = request('2030-02-01', '2030-02-03');
  const cases: [typeof fetch, string][] = [
    [respond(503, { error: 'pricing-unavailable' }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(503, { error: 'database-error' }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(500, { error: 'internal-error' }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(502, '<html>Bad gateway</html>'), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    // 200, ale nepoužitelná odpověď: neznámý režim, jiný termín, cena jako text, chybějící pole.
    [respond(200, { arrivalDate: '2030-02-01', departureDate: '2030-02-03', nights: 2, pricingMode: 'package', subtotalCzk: 1, discount: null, totalCzk: 1, nightlyPrices: [] }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(200, { arrivalDate: '2030-02-02', departureDate: '2030-02-03', nights: 1, pricingMode: 'nightly', subtotalCzk: 1, discount: null, totalCzk: 1, nightlyPrices: [] }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(200, { arrivalDate: '2030-02-01', departureDate: '2030-02-03', nights: 2, pricingMode: 'nightly', subtotalCzk: '6000', discount: null, totalCzk: '6000', nightlyPrices: [] }), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [respond(200, {}), 'Cenu teď nelze spočítat. Zkuste to prosím za chvíli.'],
    [(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch, 'Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.'],
  ];
  for (const [fetchFn, message] of cases) {
    const result = await fetchQuote(req, live(), fetchFn);
    assert.ok(!result.ok && 'error' in result);
    const view = quoteView({ status: 'error', request: req, error: result.error }, cs);
    assert.deepEqual(view, { kind: 'error', message, retryable: true, retryLabel: 'Zkusit znovu' });
    assert.ok(!/pricing-unavailable|database-error|internal-error|invalid-response|Bad gateway/.test(view.message));
  }
});

test('požadavek odpovídá kontraktu: POST /api/quote, JSON, jen arrivalDate/departureDate/guests', async () => {
  const seen: Request[] = [];
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(new URL(String(input), 'https://chalupa.test.invalid'), init));
    return backendFetch(input, init);
  }) as typeof fetch;
  await fetchQuote(request('2030-02-01', '2030-02-03', 4), live(), recording);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(new URL(seen[0].url).pathname, '/api/quote');
  assert.equal(seen[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(await seen[0].json(), { arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 4 });
});

// --- načítání, souběh a změny vstupu ---

/** Ručně řízené odpovědi: každý požadavek čeká, dokud ho test nevyřeší. */
function controlledBackend() {
  const calls: { request: QuoteRequest; signal: AbortSignal; resolve: (result: QuoteResult) => void }[] = [];
  const load = (req: QuoteRequest, signal: AbortSignal) => new Promise<QuoteResult>((resolve) => calls.push({ request: req, signal, resolve }));
  const states: QuoteState[] = [];
  const loader = createQuoteLoader(load, (state) => states.push(state));
  const last = () => states[states.length - 1];
  return { calls, states, loader, last };
}
const quoteOf = (req: QuoteRequest, totalCzk: number): QuoteResult => ({
  ok: true,
  quote: { arrivalDate: req.arrivalDate, departureDate: req.departureDate, nights: 2, pricingMode: 'nightly', subtotalCzk: totalCzk, discount: null, totalCzk, nightlyPrices: [] },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('loading: hned po změně stav načítání bez ceny; stará cena se během načítání nezobrazuje', async () => {
  const b = controlledBackend();
  const first = request('2030-02-01', '2030-02-03');
  b.loader.update(first);
  assert.deepEqual(b.last(), { status: 'loading', request: first });
  const loading = quoteView(b.last(), cs);
  assert.deepEqual(loading, { kind: 'loading', label: 'Počítáme cenu…' });
  b.calls[0].resolve(quoteOf(first, 6000));
  await flush();
  assert.equal(b.last().status, 'ready');
  // Nový termín: předchozí cena okamžitě zmizí.
  const second = request('2030-02-01', '2030-02-05');
  b.loader.update(second);
  assert.deepEqual(b.last(), { status: 'loading', request: second });
  assert.ok(!('quote' in b.last()));
});

test('souběh: starší odpověď nepřepíše novější výběr (abort i pořadí)', async () => {
  const b = controlledBackend();
  const a = request('2030-02-01', '2030-02-03');
  const c = request('2030-02-01', '2030-02-06');
  b.loader.update(a);
  b.loader.update(c);
  assert.equal(b.calls[0].signal.aborted, true, 'starší požadavek je zrušený');
  assert.equal(b.calls[1].signal.aborted, false);
  // Novější odpoví dřív, starší (který zrušení ignoroval) až potom.
  b.calls[1].resolve(quoteOf(c, 15000));
  await flush();
  b.calls[0].resolve(quoteOf(a, 6000));
  await flush();
  const final = b.last();
  assert.ok(final.status === 'ready');
  assert.deepEqual(final.request, c);
  assert.equal(final.quote.totalCzk, 15000);
  assert.ok(!b.states.some((s) => s.status === 'ready' && s.quote.totalCzk === 6000), 'cena starého výběru se nikdy nezobrazila');
});

test('souběh: zastaralá chyba nepřepíše novější výběr', async () => {
  const b = controlledBackend();
  const a = request('2030-02-01', '2030-02-03');
  const c = request('2030-02-01', '2030-02-04');
  b.loader.update(a);
  b.loader.update(c);
  b.calls[0].resolve({ ok: false, error: { kind: 'network' } });
  await flush();
  assert.deepEqual(b.last(), { status: 'loading', request: c });
  b.calls[1].resolve(quoteOf(c, 9000));
  await flush();
  assert.equal(b.last().status, 'ready');
});

test('změna příjezdu, odjezdu nebo počtu hostů spustí nový požadavek; stejný vstup ne', async () => {
  const b = controlledBackend();
  b.loader.update(request('2030-02-01', '2030-02-03', 2));
  b.loader.update(request('2030-02-01', '2030-02-03', 2));
  assert.equal(b.calls.length, 1, 'stejný vstup se znovu neposílá');
  b.loader.update(request('2030-02-02', '2030-02-03', 2));
  b.loader.update(request('2030-02-02', '2030-02-05', 2));
  b.loader.update(request('2030-02-02', '2030-02-05', 5));
  assert.deepEqual(
    b.calls.map((c) => c.request),
    [request('2030-02-01', '2030-02-03', 2), request('2030-02-02', '2030-02-03', 2), request('2030-02-02', '2030-02-05', 2), request('2030-02-02', '2030-02-05', 5)],
  );
  assert.deepEqual(b.calls.map((c) => c.signal.aborted), [true, true, true, false]);
});

test('neúplný nebo neplatný výběr se neposílá; přechod na neúplný výběr zruší rozpracovaný požadavek', async () => {
  assert.equal(quoteRequestFor({ arrival: null, departure: null }, 2), null);
  assert.equal(quoteRequestFor({ arrival: '2030-02-01', departure: null }, 2), null);
  assert.equal(quoteRequestFor({ arrival: '2030-02-03', departure: '2030-02-01' }, 2), null);
  assert.equal(quoteRequestFor({ arrival: '2030-02-01', departure: '2030-02-03' }, 0), null);
  assert.deepEqual(quoteRequestFor({ arrival: '2030-02-01', departure: '2030-02-03' }, 3), request('2030-02-01', '2030-02-03', 3));

  const b = controlledBackend();
  b.loader.update(null);
  assert.equal(b.calls.length, 0);
  b.loader.update(request('2030-02-01', '2030-02-03'));
  b.loader.update(null);
  assert.equal(b.calls[0].signal.aborted, true);
  assert.deepEqual(b.last(), IDLE_QUOTE);
  b.calls[0].resolve(quoteOf(request('2030-02-01', '2030-02-03'), 6000));
  await flush();
  assert.deepEqual(b.last(), IDLE_QUOTE);
  assert.deepEqual(quoteView(IDLE_QUOTE, cs), { kind: 'idle' });
});

test('retry po chybě pošle stejný požadavek znovu; cancel zahodí pozdní odpověď a další update načte znovu', async () => {
  const b = controlledBackend();
  const req = request('2030-02-01', '2030-02-03');
  b.loader.update(req);
  b.calls[0].resolve({ ok: false, error: { kind: 'server', status: 503, code: 'pricing-unavailable' } });
  await flush();
  assert.equal(b.last().status, 'error');
  b.loader.retry();
  assert.equal(b.calls.length, 2);
  assert.deepEqual(b.calls[1].request, req);
  b.calls[1].resolve(quoteOf(req, 6000));
  await flush();
  assert.equal(b.last().status, 'ready');

  // Odchod ze stránky (a React StrictMode: unmount + mount se stejným vstupem).
  const other = request('2030-03-01', '2030-03-03');
  b.loader.update(other);
  b.loader.cancel();
  assert.equal(b.calls[2].signal.aborted, true);
  const count = b.states.length;
  b.calls[2].resolve(quoteOf(other, 6000));
  await flush();
  assert.equal(b.states.length, count, 'po cancel žádná změna stavu');
  b.loader.update(other);
  assert.equal(b.calls.length, 4, 'po cancel se stejný vstup načte znovu');
});

test('zrušený fetch (AbortError) se nehlásí jako síťová chyba', async () => {
  const controller = new AbortController();
  const abortingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
  const pending = fetchQuote(request('2030-02-01', '2030-02-03'), controller.signal, abortingFetch);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, aborted: true });
});

// --- i18n ---

test('i18n: české texty, množná čísla, formát data a ceny přes Intl; další jazyky připravené', () => {
  assert.deepEqual([...LOCALES], ['cs', 'de', 'en', 'uk']);
  assert.ok(isLocale('uk') && !isLocale('sk') && !isLocale(undefined));
  assert.deepEqual([1, 2, 4, 5, 30].map((n) => cs.plural('booking.nights', n)), ['1 noc', '2 noci', '4 noci', '5 nocí', '30 nocí']);
  assert.deepEqual([1, 3, 7].map((n) => cs.plural('booking.guests', n)), ['1 host', '3 hosté', '7 hostů']);
  assert.equal(plain(cs.formatPrice(28500)), '28 500 Kč');
  assert.equal(plain(cs.formatPrice(0)), '0 Kč');
  assert.equal(plain(cs.formatDate('2030-12-07')), 'so 7. 12. 2030');
  assert.equal(cs.t('booking.panel.capacity', { capacity: 7 }), 'Za celou chalupu · až 7 hostů');
  // Jazyk bez překladu: texty česky (fallback), formát podle jazyka.
  const de = createI18n('de');
  assert.equal(de.t('booking.quote.exactStay'), 'Pevná cena pro tento termín');
  assert.equal(plain(de.formatPrice(28500)), '28.500 CZK');
});

// --- žádný výpočet ceny ve frontendu ---

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('frontend nikde nepočítá cenu: žádné PRICE_PER_NIGHT, 3000 ani násobení nocí', () => {
  const root = new URL('..', import.meta.url).pathname;
  const files = [...sourceFiles(join(root, 'components')), ...sourceFiles(join(root, 'app')), ...sourceFiles(join(root, 'lib', 'i18n'))];
  assert.ok(files.some((f) => f.endsWith('BookingPanel.tsx')) && files.some((f) => f.endsWith('BookingSection.tsx')));
  for (const file of files) {
    const code = readFileSync(file, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/PRICE_PER_NIGHT/.test(code), `${file}: PRICE_PER_NIGHT`);
    assert.ok(!/\b3_?000\b/.test(code), `${file}: číslo 3000`);
    assert.ok(!/(nights|count|nocí)\s*\*|\*\s*(nights|count)\b/i.test(code), `${file}: násobení nocí`);
    assert.ok(!/discount_percent|percent\s*\/\s*100|\/\s*100\s*\)/.test(code), `${file}: klientská kopie slevových pravidel`);
  }
});
