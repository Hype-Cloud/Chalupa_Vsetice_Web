import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contactComplete,
  createReservationController,
  EMPTY_CONTACT,
  FIELD_ERROR_KEYS,
  isRetryable,
  payloadFingerprint,
  postReservation,
  reservationErrorKey,
  reservationPayload,
  submitBlock,
  SUBMIT_BLOCK_KEYS,
  type ContactDraft,
  type ReservationPayload,
  type SubmissionState,
  type SubmitResult,
} from '../components/booking/reservation.ts';
import { BOOKING_DISABLED, fetchBookingConfig } from '../components/booking/bookingConfig.ts';
import { bookingConfig, handleBookingConfig } from '../worker/booking/config.ts';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { CATALOGS, createI18n, LOCALES } from '../lib/i18n/index.ts';
import { parseJsonc } from '../scripts/lib/d1-migrations.ts';
import { createTestDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Veřejný rezervační formulář: request podle kontraktu POST /api/reservations, životní cyklus
// Idempotency-Key, Turnstile, změna ceny a chybové stavy. Jen smyšlené údaje (2030, .invalid).

const CONTACT: ContactDraft = { firstName: 'Jan', lastName: 'Testovací', email: 'host@example.invalid', phone: '+420 000 000 000', note: '' };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const payload = (overrides: Partial<{ arrival: string; departure: string; guests: number; contact: ContactDraft; expectedPriceCzk: number }> = {}): ReservationPayload =>
  reservationPayload({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, contact: CONTACT, expectedPriceCzk: 9000, ...overrides });

// --- request a pravidla odeslání ---

test('request: pole podle backendového kontraktu, prázdná poznámka = null, cena z nabídky', () => {
  assert.deepEqual(payload(), {
    arrival: '2030-02-01',
    departure: '2030-02-04',
    guests: 2,
    firstName: 'Jan',
    lastName: 'Testovací',
    email: 'host@example.invalid',
    phone: '+420 000 000 000',
    note: null,
    expectedPriceCzk: 9000,
  });
  assert.equal(payload({ contact: { ...CONTACT, note: '   ' } }).note, null);
  assert.equal(payload({ contact: { ...CONTACT, note: 'Přijedeme pozdě.' } }).note, 'Přijedeme pozdě.');
  // Otisk operace zahrnuje obsah i potvrzenou cenu, ne token.
  assert.notEqual(payloadFingerprint(payload()), payloadFingerprint(payload({ expectedPriceCzk: 9500 })));
  assert.notEqual(payloadFingerprint(payload()), payloadFingerprint(payload({ guests: 3 })));
  assert.equal(payloadFingerprint(payload()), payloadFingerprint(payload()));
});

test('kontakty jsou nezávislé na termínu a hostech: změna pobytu je nezmění', () => {
  const contact = { ...CONTACT, note: 'Pes s námi' };
  const first = payload({ contact });
  const changed = payload({ contact, arrival: '2030-03-01', departure: '2030-03-05', guests: 5, expectedPriceCzk: 12000 });
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'note'] as const) assert.equal(changed[field], first[field]);
});

test('odeslání: neplatný termín, načítaná nebo chybějící cena, kontakty a Turnstile ho zablokují; platná nabídka ho povolí', () => {
  const ok = { stayComplete: true, quoteStatus: 'ready' as const, contact: CONTACT, turnstileToken: TOKEN, submission: { status: 'idle' } as SubmissionState };
  assert.equal(submitBlock(ok), null);
  assert.equal(submitBlock({ ...ok, stayComplete: false }), 'stay');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'loading' }), 'quote-loading');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'error' }), 'quote-unavailable');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'idle' }), 'quote-unavailable');
  assert.equal(submitBlock({ ...ok, contact: { ...CONTACT, phone: ' ' } }), 'contact');
  assert.equal(submitBlock({ ...ok, contact: EMPTY_CONTACT }), 'contact');
  assert.equal(submitBlock({ ...ok, turnstileToken: null }), 'turnstile');
  assert.equal(submitBlock({ ...ok, submission: { status: 'submitting' } }), 'submitting');
  // Poznámka je volitelná.
  assert.ok(contactComplete({ ...CONTACT, note: '' }));
  for (const locale of LOCALES) {
    for (const key of Object.values(SUBMIT_BLOCK_KEYS)) assert.ok(CATALOGS[locale][key], `${locale} ${key}`);
  }
});

// --- stavový automat a Idempotency-Key ---

function controller(results: SubmitResult[]) {
  const calls: { payload: ReservationPayload; token: string; key: string }[] = [];
  const states: SubmissionState[] = [];
  let keys = 0;
  let resets = 0;
  let priceRefreshes = 0;
  const c = createReservationController({
    post: async (p, token, key) => {
      calls.push({ payload: p, token, key });
      return results.shift() ?? { kind: 'error', code: 'internal-error' };
    },
    newKey: () => `00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`,
    onChange: (s) => states.push(s),
    onTurnstileReset: () => resets++,
    onPriceChanged: () => priceRefreshes++,
  });
  return { c, calls, states, last: () => states[states.length - 1], resets: () => resets, priceRefreshes: () => priceRefreshes };
}
const SUCCESS: SubmitResult = { kind: 'success', reservation: { code: 'CV-ABC234', arrival: '2030-02-01', departure: '2030-02-04', guests: 2, priceCzk: 9000, nights: 3 }, replayed: false };

test('úspěch: jeden request s UUID klíčem a tokenem; stav success', async () => {
  const t = controller([SUCCESS]);
  await t.c.submit(payload(), TOKEN);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].token, TOKEN);
  assert.match(t.calls[0].key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(t.states.map((s) => s.status), ['submitting', 'success']);
  // Po úspěchu se nic dalšího neodešle.
  await t.c.submit(payload(), TOKEN);
  assert.equal(t.calls.length, 1);
});

test('retry stejné operace po síťové chybě nebo dočasné chybě serveru: stejný klíč i token, žádný reset widgetu', async () => {
  const t = controller([
    { kind: 'error', code: 'network' },
    { kind: 'error', code: 'availability-check-failed' },
    { kind: 'error', code: 'turnstile-unavailable' },
    SUCCESS,
  ]);
  for (let i = 0; i < 4; i++) await t.c.submit(payload(), TOKEN);
  assert.equal(new Set(t.calls.map((c) => c.key)).size, 1, 'jeden klíč pro celou operaci');
  assert.deepEqual(t.calls.map((c) => c.token), [TOKEN, TOKEN, TOKEN, TOKEN]);
  assert.equal(t.resets(), 0);
  assert.equal(t.last().status, 'success');
  assert.deepEqual(t.states.filter((s) => s.status === 'error').map((s) => (s as { retryable: boolean }).retryable), [true, true, true]);
});

test('retry po expiraci tokenu: stejný klíč, nový platný token z widgetu', async () => {
  const t = controller([{ kind: 'error', code: 'network' }, SUCCESS]);
  await t.c.submit(payload(), TOKEN);
  await t.c.submit(payload(), 'NOVY.TOKEN.PO.EXPIRACI');
  assert.equal(t.calls[0].key, t.calls[1].key);
  assert.equal(t.calls[1].token, 'NOVY.TOKEN.PO.EXPIRACI');
});

test('nová logická operace (jiný termín, hosté, kontakt) = nový klíč', async () => {
  const t = controller([{ kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }]);
  await t.c.submit(payload(), TOKEN);
  await t.c.submit(payload({ arrival: '2030-02-02' }), TOKEN);
  await t.c.submit(payload({ arrival: '2030-02-02', guests: 4 }), TOKEN);
  await t.c.submit(payload({ arrival: '2030-02-02', guests: 4, contact: { ...CONTACT, phone: '+420 111 111 111' } }), TOKEN);
  assert.equal(new Set(t.calls.map((c) => c.key)).size, 4);
});

test('turnstile-failed / turnstile-required: reset widgetu a nová operace s novým klíčem', async () => {
  for (const code of ['turnstile-failed', 'turnstile-required']) {
    const t = controller([{ kind: 'error', code }, SUCCESS]);
    await t.c.submit(payload(), TOKEN);
    assert.equal(t.resets(), 1, code);
    assert.deepEqual(t.last(), { status: 'error', code, retryable: false });
    await t.c.submit(payload(), 'NOVY.TOKEN');
    assert.notEqual(t.calls[0].key, t.calls[1].key, code);
  }
});

test('price-mismatch: žádné automatické odeslání, nová cena, kontakty zachované, nové potvrzení s novým klíčem', async () => {
  const contact = { ...CONTACT, note: 'Prosíme postýlku' };
  const t = controller([{ kind: 'price-mismatch', priceCzk: 13500 }, SUCCESS]);
  await t.c.submit(payload({ contact, expectedPriceCzk: 12000 }), TOKEN);
  assert.equal(t.calls.length, 1, 'po změně ceny se nic automaticky neodeslalo');
  assert.deepEqual(t.last(), { status: 'price-changed', fromCzk: 12000, toCzk: 13500 });
  assert.equal(t.priceRefreshes(), 1, 'znovu načtená autoritativní nabídka');
  assert.equal(t.resets(), 0, 'Turnstile se kvůli změně ceny neresetuje');
  // Uživatel vědomě potvrdí novou cenu.
  await t.c.submit(payload({ contact, expectedPriceCzk: 13500 }), TOKEN);
  assert.equal(t.calls.length, 2);
  assert.notEqual(t.calls[1].key, t.calls[0].key, 'nové potvrzení = nový Idempotency-Key');
  assert.equal(t.calls[1].payload.expectedPriceCzk, 13500);
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'note'] as const) assert.equal(t.calls[1].payload[field], t.calls[0].payload[field]);
  assert.equal(t.last().status, 'success');
});

test('dates-unavailable, 422 a idempotency-key-reused končí operaci (další odeslání = nový klíč)', async () => {
  for (const result of [{ kind: 'error', code: 'dates-unavailable' }, { kind: 'invalid', fields: ['email'] }, { kind: 'error', code: 'idempotency-key-reused' }] as SubmitResult[]) {
    const t = controller([result, SUCCESS]);
    await t.c.submit(payload(), TOKEN);
    await t.c.submit(payload(), TOKEN);
    assert.notEqual(t.calls[0].key, t.calls[1].key, JSON.stringify(result));
  }
});

test('dvojklik během odesílání ani chybějící token nic neodešle; dismiss zahodí chybovou hlášku', async () => {
  let release!: (r: SubmitResult) => void;
  const calls: string[] = [];
  const states: SubmissionState[] = [];
  const c = createReservationController({
    post: (_p, _t, key) => (calls.push(key), new Promise((resolve) => (release = resolve))),
    newKey: () => crypto.randomUUID(),
    onChange: (s) => states.push(s),
    onTurnstileReset: () => undefined,
    onPriceChanged: () => undefined,
  });
  await c.submit(payload(), '');
  assert.equal(calls.length, 0, 'bez tokenu se neodesílá');
  const first = c.submit(payload(), TOKEN);
  await c.submit(payload(), TOKEN);
  assert.equal(calls.length, 1, 'druhé kliknutí během odesílání se ignoruje');
  release({ kind: 'error', code: 'rate-limited' });
  await first;
  assert.equal(c.state().status, 'error');
  c.dismiss();
  assert.equal(c.state().status, 'idle');
});

test('každý podporovaný chybový kód → srozumitelná hláška ve všech jazycích, bez technického kódu', () => {
  const codes = [
    'turnstile-required', 'turnstile-failed', 'turnstile-unavailable', 'rate-limited', 'dates-unavailable', 'price-mismatch',
    'pricing-unavailable', 'availability-check-failed', 'availability-incomplete', 'invalid-request', 'internal-error', 'network',
  ];
  const keys = codes.filter((c) => c !== 'price-mismatch').map(reservationErrorKey);
  assert.equal(new Set(keys).size, keys.length, 'každý kód má vlastní hlášku');
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    for (const key of keys) {
      const text = i18n.t(key);
      assert.ok(text.length > 10 && !/[a-z]+-[a-z]+-?[a-z]*/.test(text.replace(/e-chalupy\.cz|E-Mail|e-mail|Wi-Fi/gi, '')), `${locale} ${key}: ${text}`);
    }
    // Změna ceny: hláška s oběma částkami.
    const changed = i18n.t('reservation.priceChanged', { from: i18n.formatPrice(12000), to: i18n.formatPrice(13500) });
    assert.ok(changed.includes(i18n.formatPrice(12000)) && changed.includes(i18n.formatPrice(13500)), changed);
    for (const key of Object.values(FIELD_ERROR_KEYS)) assert.ok(i18n.t(key).length > 5);
  }
  assert.equal(createI18n('cs').t('reservation.priceChanged', { from: '12 000 Kč', to: '13 500 Kč' }), 'Cena se mezitím změnila z 12 000 Kč na 13 500 Kč. Zkontrolujte ji a rezervaci znovu potvrďte.');
  // Neznámý kód (např. vypnutý endpoint) → obecná hláška.
  assert.equal(reservationErrorKey('not-found'), 'reservation.error.internalError');
  assert.equal(reservationErrorKey('něco-nového'), 'reservation.error.internalError');
  assert.deepEqual(['network', 'rate-limited', 'pricing-unavailable', 'availability-incomplete', 'internal-error'].map(isRetryable), [true, true, true, true, true]);
  assert.deepEqual(['turnstile-failed', 'turnstile-required', 'dates-unavailable', 'idempotency-key-reused', 'not-found'].map(isRetryable), [false, false, false, false, false]);
});

// --- proti skutečnému POST /api/reservations (Miniflare D1, falešné Siteverify a export) ---

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(async () => {
  await t.db.prepare('DELETE FROM daily_prices').run();
  await t.reset();
});

function backend(options: { siteverify?: boolean; env?: Partial<BookingEnv> } = {}) {
  const requests: Request[] = [];
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: 'preview', BOOKING_API_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...options.env,
  };
  let uuid = 0;
  const upstream = (async (input: RequestInfo | URL) =>
    String(input) === SITEVERIFY_URL ? Response.json({ success: options.siteverify ?? true, 'error-codes': options.siteverify === false ? ['invalid-input-response'] : [] }) : new Response(fixture('01-single-and-multi.ics'))) as typeof fetch;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), 'https://preview.test.invalid'), init);
    requests.push(request.clone() as Request);
    return handleCreateReservation(request, env, {
      fetch: upstream,
      now: () => new Date('2030-01-10T10:00:00Z'),
      randomUUID: () => `00000000-0000-4000-9000-${String(++uuid).padStart(12, '0')}`,
      log: () => undefined,
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

test('POST: správný request (JSON, Idempotency-Key, turnstileToken, expectedPriceCzk) a potvrzení bez kontaktů', async () => {
  const b = backend();
  const key = crypto.randomUUID();
  const result = await postReservation(payload({ contact: { ...CONTACT, note: 'Přijedeme večer.' } }), TOKEN, key, b.fetchFn);
  assert.deepEqual(result, { kind: 'success', reservation: { code: (result as { reservation: { code: string } }).reservation.code, arrival: '2030-02-01', departure: '2030-02-04', guests: 2, priceCzk: 9000, nights: 3 }, replayed: false });
  const [request] = b.requests;
  assert.equal(request.method, 'POST');
  assert.equal(new URL(request.url).pathname, '/api/reservations');
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.equal(request.headers.get('idempotency-key'), key);
  assert.deepEqual(await request.json(), { ...payload({ contact: { ...CONTACT, note: 'Přijedeme večer.' } }), turnstileToken: TOKEN });
  assert.deepEqual(await t.db.prepare('SELECT first_name, note, price_czk FROM reservations').first(), { first_name: 'Jan', note: 'Přijedeme večer.', price_czk: 9000 });
  // Opakování stejné operace (např. ztracená odpověď) → idempotentní replay, žádná druhá rezervace.
  const replay = await postReservation(payload({ contact: { ...CONTACT, note: 'Přijedeme večer.' } }), TOKEN, key, b.fetchFn);
  assert.equal(replay.kind, 'success');
  assert.equal((replay as { replayed: boolean }).replayed, true);
  assert.equal(await t.count('reservations'), 1);
});

test('POST: změna ceny na serveru → price-mismatch s novou cenou; po vědomém potvrzení nový klíč a úspěch, kontakty beze změny', async () => {
  const b = backend();
  // Host viděl 9 000 Kč; mezitím se ceník změnil (noc 2. 2. = 4 500 Kč → 10 500 Kč).
  await t.db.prepare(`INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-02', 4500)`).run();
  const states: SubmissionState[] = [];
  let refreshed = 0;
  const c = createReservationController({
    post: (p, token, key) => postReservation(p, token, key, b.fetchFn),
    newKey: () => crypto.randomUUID(),
    onChange: (s) => states.push(s),
    onTurnstileReset: () => undefined,
    onPriceChanged: () => refreshed++,
  });
  const contact = { ...CONTACT, note: 'Poznámka zůstává' };
  await c.submit(payload({ contact, expectedPriceCzk: 9000 }), TOKEN);
  assert.deepEqual(c.state(), { status: 'price-changed', fromCzk: 9000, toCzk: 10500 });
  assert.equal(refreshed, 1);
  assert.equal(b.requests.length, 1, 'žádné automatické druhé odeslání');
  assert.equal(await t.count('reservations'), 0);
  await c.submit(payload({ contact, expectedPriceCzk: 10500 }), TOKEN);
  assert.equal(c.state().status, 'success');
  assert.notEqual(b.requests[0].headers.get('idempotency-key'), b.requests[1].headers.get('idempotency-key'));
  assert.deepEqual(await t.db.prepare('SELECT note, price_czk FROM reservations').first(), { note: 'Poznámka zůstává', price_czk: 10500 });
});

test('POST: 422 s poli, neplatný Turnstile a vypnutý endpoint → mapované stavy', async () => {
  const invalid = await postReservation(payload({ contact: { ...CONTACT, email: 'neplatny' } }), TOKEN, crypto.randomUUID(), backend().fetchFn);
  assert.deepEqual(invalid, { kind: 'invalid', fields: ['email'] });
  const failed = await postReservation(payload(), TOKEN, crypto.randomUUID(), backend({ siteverify: false }).fetchFn);
  assert.deepEqual(failed, { kind: 'error', code: 'turnstile-failed' });
  const disabled = await postReservation(payload(), TOKEN, crypto.randomUUID(), backend({ env: { BOOKING_API_ENABLED: undefined } }).fetchFn);
  assert.deepEqual(disabled, { kind: 'error', code: 'not-found' });
  const network = await postReservation(payload(), TOKEN, crypto.randomUUID(), (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch);
  assert.deepEqual(network, { kind: 'error', code: 'network' });
  assert.equal(await t.count('reservations'), 0);
});

// --- GET /api/booking-config ---

test('booking-config: jen bookingEnabled a veřejný site key; produkce vypnutá', async () => {
  assert.deepEqual(bookingConfig({}), { bookingEnabled: false, turnstileSiteKey: null });
  assert.deepEqual(bookingConfig({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }), { bookingEnabled: false, turnstileSiteKey: null }, 'bez zapnuté rezervace žádný klíč');
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'TRUE', TURNSTILE_SITE_KEY: 'x' }), { bookingEnabled: false, turnstileSiteKey: null });
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }), { bookingEnabled: true, turnstileSiteKey: '1x00000000000000000000AA' });
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'true' }), { bookingEnabled: true, turnstileSiteKey: null });

  const response = handleBookingConfig(new Request('https://x.invalid/api/booking-config'), { BOOKING_API_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', ...({ TURNSTILE_SECRET_KEY: 'TAJNE' } as object) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['bookingEnabled', 'turnstileSiteKey'], 'žádné další interní nastavení');
  assert.ok(!JSON.stringify(body).includes('TAJNE'));
  assert.equal(handleBookingConfig(new Request('https://x.invalid/api/booking-config', { method: 'POST' }), {}).status, 405);
});

test('booking-config ve frontendu: chyba nebo neúplná odpověď = formulář vypnutý (fallback na e-chalupy)', async () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await fetchBookingConfig(respond(200, { bookingEnabled: true, turnstileSiteKey: 'site' })), { bookingEnabled: true, turnstileSiteKey: 'site' });
  assert.deepEqual(await fetchBookingConfig(respond(200, { bookingEnabled: true, turnstileSiteKey: null })), BOOKING_DISABLED);
  assert.deepEqual(await fetchBookingConfig(respond(200, { bookingEnabled: false, turnstileSiteKey: 'site' })), BOOKING_DISABLED);
  assert.deepEqual(await fetchBookingConfig(respond(500, { error: 'internal-error' })), BOOKING_DISABLED);
  assert.deepEqual(await fetchBookingConfig(respond(200, 'nesmysl')), BOOKING_DISABLED);
  assert.deepEqual(await fetchBookingConfig((async () => {
    throw new TypeError('offline');
  }) as unknown as typeof fetch), BOOKING_DISABLED);
});

test('wrangler.jsonc: veřejný testovací site key jen v Preview, produkce bez rezervace i bez site key', () => {
  const config = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as { vars: Record<string, string>; previews: { vars: Record<string, string> } };
  assert.equal(config.previews.vars.TURNSTILE_SITE_KEY, '1x00000000000000000000AA');
  assert.equal(config.previews.vars.BOOKING_API_ENABLED, 'true');
  assert.ok(!('TURNSTILE_SITE_KEY' in config.vars));
  assert.ok(!('BOOKING_API_ENABLED' in config.vars), 'produkční POST zůstává vypnutý');
  assert.ok(!Object.keys(config.previews.vars).some((k) => /SECRET/.test(k)), 'secret nepatří do vars');
});
