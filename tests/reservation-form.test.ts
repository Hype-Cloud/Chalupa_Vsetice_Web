import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contactComplete,
  createReservationController,
  EMPTY_CONTACT,
  FIELD_ERROR_KEYS,
  isRetryable,
  parseConfirmation,
  payloadFingerprint,
  postReservation,
  reservationErrorKey,
  reservationPayload,
  submitBlock,
  type ContactDraft,
  type ReservationPayload,
  type SubmissionState,
  type SubmitResult,
} from '../components/booking/reservation.ts';
import { BOOKING_DISABLED, fetchBookingConfig } from '../components/booking/bookingConfig.ts';
import { bookingConfig, handleBookingConfig } from '../worker/booking/config.ts';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { TurnstileError } from '../components/booking/invisibleTurnstile.ts';
import { CATALOGS, createI18n, LOCALES } from '../lib/i18n/index.ts';
import { parseJsonc } from '../scripts/lib/d1-migrations.ts';
import { createTestDatabase } from './d1.ts';
import { fixture, FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN } from './helpers.ts';

// Veřejný rezervační formulář: request podle kontraktu POST /api/reservations, životní cyklus
// Idempotency-Key, Turnstile, změna ceny a chybové stavy. Jen smyšlené údaje (2030, .invalid).

const CONTACT: ContactDraft = { firstName: 'Jan', lastName: 'Testovací', email: 'host@example.invalid', phone: '+420 000 000 000', note: '' };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const payload = (overrides: Partial<{ arrival: string; departure: string; guests: number; contact: ContactDraft; expectedPriceCzk: number }> = {}): ReservationPayload =>
  reservationPayload({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, contact: CONTACT, expectedPriceCzk: 8970, ...overrides });

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
    expectedPriceCzk: 8970,
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

test('odeslání: neplatný termín, načítaná nebo chybějící cena a kontakty ho zablokují; Turnstile token předem nutný není', () => {
  const ok = { stayComplete: true, quoteStatus: 'ready' as const, contact: CONTACT, submission: { status: 'idle' } as SubmissionState };
  assert.equal(submitBlock(ok), null);
  assert.equal(submitBlock({ ...ok, stayComplete: false }), 'stay');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'loading' }), 'quote-loading');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'error' }), 'quote-unavailable');
  assert.equal(submitBlock({ ...ok, quoteStatus: 'idle' }), 'quote-unavailable');
  assert.equal(submitBlock({ ...ok, contact: { ...CONTACT, phone: ' ' } }), 'contact');
  assert.equal(submitBlock({ ...ok, contact: EMPTY_CONTACT }), 'contact');
  assert.equal(submitBlock({ ...ok, submission: { status: 'submitting' } }), 'submitting');
  // Poznámka je volitelná.
  assert.ok(contactComplete({ ...CONTACT, note: '' }));
  // Důvod blokace se nezobrazuje jako výchozí text pod formulářem („Vyplňte jméno…“, „počkejte na
  // ověření“); zůstává jen hláška ke „Pokračovat k rezervaci“ bez termínu.
  for (const locale of LOCALES) {
    const keys = Object.keys(CATALOGS[locale]);
    assert.deepEqual(keys.filter((k) => k.startsWith('reservation.blocked.')), ['reservation.blocked.stay'], locale);
    assert.ok(!keys.some((k) => k.startsWith('reservation.turnstile.') || k === 'reservation.form.optional'), locale);
  }
});

// --- stavový automat, Invisible Turnstile a Idempotency-Key ---

type TokenOutcome = 'ok' | 'failed' | 'unavailable';

/**
 * Kontrolér s falešným POST a falešným Invisible Turnstile. Každé getToken() vydá nový token
 * (TOKEN-1, TOKEN-2, …) nebo selže podle fronty `tokens`; `events` zaznamenává pořadí volání.
 */
function controller(results: SubmitResult[], tokens: TokenOutcome[] = []) {
  const calls: { payload: ReservationPayload; token: string; key: string }[] = [];
  const states: SubmissionState[] = [];
  const events: string[] = [];
  let keys = 0;
  let issued = 0;
  let priceRefreshes = 0;
  const c = createReservationController({
    getToken: async () => {
      const outcome = tokens.shift() ?? 'ok';
      events.push(`turnstile:${outcome}`);
      if (outcome !== 'ok') throw new TurnstileError(outcome === 'failed' ? 'turnstile-failed' : 'turnstile-unavailable');
      return `TOKEN-${++issued}`;
    },
    post: async (p, token, key) => {
      events.push(`post:${token}`);
      calls.push({ payload: p, token, key });
      return results.shift() ?? { kind: 'error', code: 'internal-error' };
    },
    newKey: () => `00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`,
    onChange: (s) => states.push(s),
    onPriceChanged: () => priceRefreshes++,
  });
  return { c, calls, states, events, last: () => states[states.length - 1], executions: () => events.filter((e) => e.startsWith('turnstile:')).length, priceRefreshes: () => priceRefreshes };
}
const SUCCESS: SubmitResult = {
  kind: 'success',
  reservation: {
    reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', guests: 2, totalCzk: 8970, nights: 3, paymentDueAt: '2030-01-11T10:00:00.000Z',
    payment: {
      amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001',
      dueAt: '2030-01-11T10:00:00.000Z', spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001`,
    },
  },
  replayed: false,
};

test('kliknutí nejdřív spustí Invisible Turnstile, POST až s získaným tokenem; stav success', async () => {
  const t = controller([SUCCESS]);
  await t.c.submit(payload());
  assert.deepEqual(t.events, ['turnstile:ok', 'post:TOKEN-1']);
  assert.match(t.calls[0].key, /^[0-9a-f-]{36}$/);
  // Ověření i odeslání = jeden loading stav tlačítka.
  assert.deepEqual(t.states.map((s) => s.status), ['submitting', 'success']);
  // Po úspěchu se nic dalšího neodešle ani neověřuje.
  await t.c.submit(payload());
  assert.equal(t.calls.length, 1);
  assert.equal(t.executions(), 1);
});

test('selhání Turnstile (challenge i nenačtený skript) zabrání POSTu a zobrazí chybu; další kliknutí spustí Turnstile znovu', async () => {
  const t = controller([SUCCESS], ['failed', 'unavailable']);
  await t.c.submit(payload());
  assert.equal(t.calls.length, 0, 'bez tokenu žádný POST');
  assert.deepEqual(t.last(), { status: 'error', code: 'turnstile-failed', retryable: false });
  await t.c.submit(payload());
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.last(), { status: 'error', code: 'turnstile-unavailable', retryable: true });
  await t.c.submit(payload());
  assert.deepEqual(t.events, ['turnstile:failed', 'turnstile:unavailable', 'turnstile:ok', 'post:TOKEN-1']);
  assert.equal(t.last().status, 'success');
  // Neočekávaná chyba klientské části = turnstile-failed.
  const odd = createReservationController({
    getToken: async () => {
      throw new Error('něco jiného');
    },
    post: async () => SUCCESS,
    newKey: () => crypto.randomUUID(),
    onChange: () => undefined,
    onPriceChanged: () => undefined,
  });
  await odd.submit(payload());
  assert.deepEqual(odd.state(), { status: 'error', code: 'turnstile-failed', retryable: false });
});

test('retry stejné operace po síťové nebo dočasné chybě serveru: stejný klíč i token, Turnstile se znovu nespouští', async () => {
  const t = controller([
    { kind: 'error', code: 'network' },
    { kind: 'error', code: 'availability-check-failed' },
    { kind: 'error', code: 'turnstile-unavailable' },
    SUCCESS,
  ]);
  for (let i = 0; i < 4; i++) await t.c.submit(payload());
  assert.equal(t.executions(), 1, 'jedna Turnstile challenge pro celou operaci');
  assert.equal(new Set(t.calls.map((c) => c.key)).size, 1, 'jeden klíč pro celou operaci');
  assert.deepEqual(t.calls.map((c) => c.token), ['TOKEN-1', 'TOKEN-1', 'TOKEN-1', 'TOKEN-1']);
  assert.equal(t.last().status, 'success');
  assert.deepEqual(t.states.filter((s) => s.status === 'error').map((s) => (s as { retryable: boolean }).retryable), [true, true, true]);
});

test('změna termínu, hostů nebo kontaktu po předchozím odeslání = nová operace: nový Turnstile token i nový klíč', async () => {
  const t = controller([{ kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }, { kind: 'error', code: 'network' }, SUCCESS]);
  await t.c.submit(payload());
  await t.c.submit(payload({ arrival: '2030-02-02' }));
  await t.c.submit(payload({ arrival: '2030-02-02', guests: 4 }));
  await t.c.submit(payload({ arrival: '2030-02-02', guests: 4, contact: { ...CONTACT, phone: '+420 111 111 111' } }));
  assert.equal(t.executions(), 4);
  assert.equal(new Set(t.calls.map((c) => c.key)).size, 4);
  assert.deepEqual(t.calls.map((c) => c.token), ['TOKEN-1', 'TOKEN-2', 'TOKEN-3', 'TOKEN-4']);
  // Návrat k předchozímu obsahu není retry staré operace (ta skončila změnou) – opět nový token.
  await t.c.submit(payload());
  assert.equal(t.calls[4].token, 'TOKEN-5');
  assert.notEqual(t.calls[4].key, t.calls[0].key);
});

test('turnstile-failed / turnstile-required ze serveru: operace končí, další kliknutí = nový token i klíč', async () => {
  for (const code of ['turnstile-failed', 'turnstile-required']) {
    const t = controller([{ kind: 'error', code }, SUCCESS]);
    await t.c.submit(payload());
    assert.deepEqual(t.last(), { status: 'error', code, retryable: false });
    await t.c.submit(payload());
    assert.deepEqual(t.calls.map((c) => c.token), ['TOKEN-1', 'TOKEN-2'], code);
    assert.notEqual(t.calls[0].key, t.calls[1].key, code);
  }
});

test('price-mismatch: žádné automatické odeslání; vědomé potvrzení = nová operace s novým tokenem (spotřebovaný se nepoužije)', async () => {
  const contact = { ...CONTACT, note: 'Prosíme postýlku' };
  const t = controller([{ kind: 'price-mismatch', priceCzk: 13500 }, SUCCESS]);
  await t.c.submit(payload({ contact, expectedPriceCzk: 12000 }));
  assert.equal(t.calls.length, 1, 'po změně ceny se nic automaticky neodeslalo');
  assert.equal(t.executions(), 1, 'ani se automaticky nespustil Turnstile');
  assert.deepEqual(t.last(), { status: 'price-changed', fromCzk: 12000, toCzk: 13500 });
  assert.equal(t.priceRefreshes(), 1, 'znovu načtená autoritativní nabídka');
  // Uživatel vědomě potvrdí novou cenu.
  await t.c.submit(payload({ contact, expectedPriceCzk: 13500 }));
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].token, 'TOKEN-2', 'nový token, ne spotřebovaný TOKEN-1');
  assert.notEqual(t.calls[1].key, t.calls[0].key, 'nové potvrzení = nový Idempotency-Key');
  assert.equal(t.calls[1].payload.expectedPriceCzk, 13500);
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'note'] as const) assert.equal(t.calls[1].payload[field], t.calls[0].payload[field]);
  assert.equal(t.last().status, 'success');
});

test('price-mismatch a potvrzení původní ceny (stejný obsah): přesto nová operace s novým tokenem', async () => {
  const t = controller([{ kind: 'price-mismatch', priceCzk: 8970 }, SUCCESS]);
  await t.c.submit(payload());
  await t.c.submit(payload());
  assert.deepEqual(t.calls.map((c) => c.token), ['TOKEN-1', 'TOKEN-2']);
  assert.notEqual(t.calls[0].key, t.calls[1].key);
});

test('dates-unavailable, 422 a idempotency-key-reused končí operaci (další odeslání = nový token i klíč)', async () => {
  for (const result of [{ kind: 'error', code: 'dates-unavailable' }, { kind: 'invalid', fields: ['email'] }, { kind: 'error', code: 'idempotency-key-reused' }] as SubmitResult[]) {
    const t = controller([result, SUCCESS]);
    await t.c.submit(payload());
    await t.c.submit(payload());
    assert.notEqual(t.calls[0].key, t.calls[1].key, JSON.stringify(result));
    assert.deepEqual(t.calls.map((c) => c.token), ['TOKEN-1', 'TOKEN-2'], JSON.stringify(result));
  }
});

test('dvojklik během ověření i odesílání nic dalšího nespustí; dismiss zahodí chybovou hlášku', async () => {
  let release!: (r: SubmitResult) => void;
  let issue!: (token: string) => void;
  const calls: string[] = [];
  let executions = 0;
  const c = createReservationController({
    getToken: () => (executions++, new Promise((resolve) => (issue = resolve))),
    post: (_p, _t, key) => (calls.push(key), new Promise((resolve) => (release = resolve))),
    newKey: () => crypto.randomUUID(),
    onChange: () => undefined,
    onPriceChanged: () => undefined,
  });
  const first = c.submit(payload());
  assert.equal(c.state().status, 'submitting', 'loading stav už během ověření');
  await c.submit(payload());
  assert.equal(executions, 1, 'druhé kliknutí během ověření se ignoruje');
  issue(TOKEN);
  await new Promise((resolve) => setImmediate(resolve));
  await c.submit(payload());
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
    PAYMENT_IBAN: FAKE_PAYMENT_IBAN, TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...options.env,
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
  // Potvrzení nese jen data ze serverové odpovědi: kód z D1, cena z /api/quote výpočtu, splatnost a SPAYD.
  assert.deepEqual(result, SUCCESS);
  const [request] = b.requests;
  assert.equal(request.method, 'POST');
  assert.equal(new URL(request.url).pathname, '/api/reservations');
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.equal(request.headers.get('idempotency-key'), key);
  assert.deepEqual(await request.json(), { ...payload({ contact: { ...CONTACT, note: 'Přijedeme večer.' } }), turnstileToken: TOKEN });
  assert.deepEqual(await t.db.prepare('SELECT first_name, note, price_czk FROM reservations').first(), { first_name: 'Jan', note: 'Přijedeme večer.', price_czk: 8970 });
  // Opakování stejné operace (např. ztracená odpověď) → idempotentní replay, žádná druhá rezervace.
  const replay = await postReservation(payload({ contact: { ...CONTACT, note: 'Přijedeme večer.' } }), TOKEN, key, b.fetchFn);
  assert.equal(replay.kind, 'success');
  assert.equal((replay as { replayed: boolean }).replayed, true);
  assert.equal(await t.count('reservations'), 1);
});

test('POST: změna ceny na serveru → price-mismatch s novou cenou; po vědomém potvrzení nový klíč a úspěch, kontakty beze změny', async () => {
  const b = backend();
  // Host viděl 8 970 Kč (3 × 2 990); mezitím se ceník změnil (noc 2. 2. = 4 500 Kč → 2 990 + 4 500 + 2 990 = 10 480 Kč).
  await t.db.prepare(`INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-02', 4500)`).run();
  const states: SubmissionState[] = [];
  let refreshed = 0;
  let issued = 0;
  const c = createReservationController({
    getToken: async () => `XXXX.DUMMY.TOKEN.${++issued}`,
    post: (p, token, key) => postReservation(p, token, key, b.fetchFn),
    newKey: () => crypto.randomUUID(),
    onChange: (s) => states.push(s),
    onPriceChanged: () => refreshed++,
  });
  const contact = { ...CONTACT, note: 'Poznámka zůstává' };
  await c.submit(payload({ contact, expectedPriceCzk: 8970 }));
  assert.deepEqual(c.state(), { status: 'price-changed', fromCzk: 8970, toCzk: 10480 });
  assert.equal(refreshed, 1);
  assert.equal(b.requests.length, 1, 'žádné automatické druhé odeslání');
  assert.equal(await t.count('reservations'), 0);
  await c.submit(payload({ contact, expectedPriceCzk: 10480 }));
  assert.equal(c.state().status, 'success');
  assert.notEqual(b.requests[0].headers.get('idempotency-key'), b.requests[1].headers.get('idempotency-key'));
  // Potvrzení nové ceny nese nový Turnstile token (spotřebovaný se znovu nepoužije).
  const tokens = await Promise.all(b.requests.map(async (r) => ((await r.clone().json()) as { turnstileToken: string }).turnstileToken));
  assert.deepEqual(tokens, ['XXXX.DUMMY.TOKEN.1', 'XXXX.DUMMY.TOKEN.2']);
  assert.deepEqual(await t.db.prepare('SELECT note, price_czk FROM reservations').first(), { note: 'Poznámka zůstává', price_czk: 10480 });
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
  assert.deepEqual(bookingConfig({ TURNSTILE_SITE_KEY: '1x00000000000000000000BB' }), { bookingEnabled: false, turnstileSiteKey: null }, 'bez zapnuté rezervace žádný klíč');
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'TRUE', TURNSTILE_SITE_KEY: 'x' }), { bookingEnabled: false, turnstileSiteKey: null });
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000BB' }), { bookingEnabled: true, turnstileSiteKey: '1x00000000000000000000BB' });
  assert.deepEqual(bookingConfig({ BOOKING_API_ENABLED: 'true' }), { bookingEnabled: true, turnstileSiteKey: null });

  const response = handleBookingConfig(new Request('https://x.invalid/api/booking-config'), { BOOKING_API_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000BB', ...({ TURNSTILE_SECRET_KEY: 'TAJNE' } as object) });
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

test('wrangler.jsonc: veřejný testovací Invisible site key jen v Preview, produkce bez rezervace i bez site key', () => {
  const config = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as { vars: Record<string, string>; previews: { vars: Record<string, string> } };
  // Testovací Invisible site key Cloudflare (vždy projde, bez viditelného widgetu).
  assert.equal(config.previews.vars.TURNSTILE_SITE_KEY, '1x00000000000000000000BB');
  assert.equal(config.previews.vars.BOOKING_API_ENABLED, 'true');
  assert.ok(!('TURNSTILE_SITE_KEY' in config.vars));
  assert.ok(!('BOOKING_API_ENABLED' in config.vars), 'produkční POST zůstává vypnutý');
  assert.ok(!Object.keys(config.previews.vars).some((k) => /SECRET/.test(k)), 'secret nepatří do vars');
});

test('potvrzení rezervace: neúplná nebo nekonzistentní odpověď serveru se nepřijme (nic se nedopočítává)', () => {
  const body = (reservation: Record<string, unknown>, payment: Record<string, unknown> = {}) => {
    const ok = SUCCESS as Extract<SubmitResult, { kind: 'success' }>;
    return { reservation: { ...ok.reservation, payment: undefined, ...reservation }, payment: { ...ok.reservation.payment, ...payment } };
  };
  const ok = SUCCESS as Extract<SubmitResult, { kind: 'success' }>;
  assert.deepEqual(parseConfirmation(body({})), ok.reservation);
  assert.equal(parseConfirmation({ reservation: body({}).reservation }), null, 'bez platebních údajů');
  assert.equal(parseConfirmation(body({ totalCzk: 8000 })), null, 'částka platby musí být 100 % ceny');
  assert.equal(parseConfirmation(body({}, { dueAt: '2030-01-12T10:00:00.000Z' })), null, 'splatnost musí souhlasit');
  assert.equal(parseConfirmation(body({}, { spayd: '' })), null);
  assert.equal(parseConfirmation(body({}, { currency: 'EUR' })), null);
  assert.equal(parseConfirmation(body({ reservationCode: undefined })), null);
});
