import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { qrMatrix, QR_QUIET_MODULES } from '../lib/booking/qr.ts';
import { createI18n, LOCALES, type Locale } from '../lib/i18n/index.ts';
import { confirmationRecipient, QR_CONTENT_ID, renderConfirmationEmail } from '../worker/booking/confirmation.ts';
import { handleCreateReservation, type BookingDeps, type BookingEnv } from '../worker/booking/handler.ts';
import type { ReservationResponse } from '../worker/booking/response.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { validateBooking } from '../worker/booking/validation.ts';
import { RESEND_ENDPOINT } from '../worker/email/resend.ts';
import { createTestDatabase } from './d1.ts';
import { FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN, fixture } from './helpers.ts';

// Potvrzovací e-mail po vytvoření rezervace. Jen smyšlené údaje: rok 2030, domény .invalid,
// fiktivní účet banky 9999, falešný Resend, Siteverify i export e-chalup.
const NOW = new Date('2030-01-10T10:00:00Z');
const GUEST_EMAIL = 'host-potvrzeni@example.invalid';
const TEST_INBOX = 'preview-schranka@example.invalid';
const RESEND_KEY = 're_test_FAKE_KEY_123';
const GUEST = { firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: GUEST_EMAIL };
const stay = (extra: Record<string, unknown> = {}) => ({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, ...GUEST, locale: 'cs', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', ...extra });

interface SentMail {
  headers: Headers;
  body: { from: string; to: string[]; subject: string; text: string; html: string; attachments?: { filename: string; content: string; content_id?: string }[] };
}

let preview: Awaited<ReturnType<typeof createTestDatabase>>;
let production: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => {
  preview = await createTestDatabase('preview');
  production = await createTestDatabase('production');
});
after(() => {
  preview.dispose();
  production.dispose();
});
beforeEach(async () => {
  await preview.reset();
  await production.reset();
});

function setup(options: { env?: Partial<BookingEnv>; resend?: () => Response | Promise<Response>; db?: 'preview' | 'production'; defer?: boolean } = {}) {
  const t = options.db === 'production' ? production : preview;
  const logs: string[] = [];
  const mails: SentMail[] = [];
  const deferred: Promise<unknown>[] = [];
  let uuid = 0;
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: options.db ?? 'preview', BOOKING_API_ENABLED: 'true',
    PAYMENT_IBAN: FAKE_PAYMENT_IBAN, TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
    RESEND_API_KEY: RESEND_KEY, BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX, BOOKING_EMAIL_FROM: 'Chalupa <rezervace@example.invalid>',
    ...options.env,
  };
  const deps: BookingDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SITEVERIFY_URL) return Response.json({ success: true });
      if (url === RESEND_ENDPOINT) {
        mails.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return options.resend ? options.resend() : Response.json({ id: 'fake-email-id' });
      }
      return new Response(fixture('01-single-and-multi.ics'));
    }) as typeof fetch,
    now: () => NOW,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    log: (message) => logs.push(message),
    ...(options.defer ? { defer: (promise: Promise<unknown>) => void deferred.push(promise) } : {}),
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleCreateReservation(
      new Request('https://preview.test.invalid/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
      env,
      deps,
    );
  return { t, env, logs, mails, deferred, post };
}

/** PNG z přílohy → matice modulů (scale 6, okraj QR_QUIET_MODULES), pro porovnání s qrMatrix(SPAYD). */
function decodeQrPng(base64: string): boolean[][] {
  const png = Buffer.from(base64, 'base64');
  const width = png.readUInt32BE(16);
  const idat = png.indexOf('IDAT');
  const pixels = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const rowBytes = Math.ceil(width / 8) + 1;
  const modules = width / 6 - 2 * QR_QUIET_MODULES;
  return Array.from({ length: modules }, (_, my) =>
    Array.from({ length: modules }, (_, mx) => {
      const x = (mx + QR_QUIET_MODULES) * 6 + 3;
      const y = (my + QR_QUIET_MODULES) * 6 + 3;
      return (pixels[y * rowBytes + 1 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
    }),
  );
}

const PII = [GUEST_EMAIL, 'Testovací', 'Jan', '000 000', FAKE_PAYMENT_IBAN, FAKE_ACCOUNT_NUMBER, 'SPD*', TEST_INBOX, RESEND_KEY];

test('locale: cs/en/de/ua projdou, jiná nebo chybějící hodnota je validační chyba (žádný fallback)', () => {
  for (const locale of LOCALES) {
    const result = validateBooking(stay({ locale }), '2030-01-10');
    assert.ok(result.ok && result.value.locale === locale, locale);
  }
  for (const locale of ['uk', 'CS', 'cz', '', null, 1, undefined]) {
    const result = validateBooking(stay({ locale }), '2030-01-10');
    assert.ok(!result.ok && result.fields.includes('locale'), String(locale));
  }
});

test('API: neplatný locale → 422 locale, nic se nezapíše ani neodešle', async () => {
  const s = setup();
  const response = await s.post(stay({ locale: 'uk' }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'invalid-request', fields: ['locale'] });
  assert.equal(await s.t.count('reservations'), 0);
  assert.equal(s.mails.length, 0);
});

test('nová rezervace v Preview: právě jeden e-mail na testovací schránku, locale uložené; replay ani souběžný dvojklik další neodešle', async () => {
  const s = setup();
  const key = { 'idempotency-key': 'potvrzeni-0000000000000001' };
  const first = await s.post(stay({ locale: 'de' }), key);
  assert.equal(first.status, 201);
  const api = (await first.json()) as ReservationResponse;
  assert.equal(s.mails.length, 1);
  const [mail] = s.mails;
  assert.deepEqual(mail.body.to, [TEST_INBOX], 'v Preview nikdy na adresu hosta');
  assert.equal(mail.body.from, 'Chalupa <rezervace@example.invalid>');
  assert.equal(mail.body.subject, `[TEST] Buchung eingegangen – ${api.reservation.reservationCode}`);
  assert.equal(mail.headers.get('authorization'), `Bearer ${RESEND_KEY}`);
  assert.equal(mail.headers.get('idempotency-key'), `reservation-confirmation-preview-${api.reservation.reservationCode}`);
  assert.ok(mail.body.text.includes(GUEST_EMAIL) && mail.body.html.includes(GUEST_EMAIL), 'adresa hosta jen jako informace v těle');
  assert.equal((await s.t.db.prepare('SELECT locale FROM reservations').first<{ locale: string }>())!.locale, 'de');
  // Idempotentní replay (např. ztracená odpověď) – stejná rezervace, žádný další e-mail.
  const replay = await s.post(stay({ locale: 'de' }), key);
  assert.equal(replay.status, 200);
  assert.equal(s.mails.length, 1);
  // Souběžný dvojklik s novým klíčem: jedna rezervace, jeden e-mail.
  const key2 = { 'idempotency-key': 'potvrzeni-0000000000000002' };
  const pair = await Promise.all([s.post(stay({ arrival: '2030-03-01', departure: '2030-03-04' }), key2), s.post(stay({ arrival: '2030-03-01', departure: '2030-03-04' }), key2)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 201]);
  assert.equal(s.mails.length, 2);
  assert.equal(await s.t.count('reservations'), 2);
});

test('produkce: příjemce je e-mail hosta, bez označení TEST', async () => {
  const s = setup({ db: 'production' });
  const response = await s.post(stay());
  assert.equal(response.status, 201);
  assert.equal(s.mails.length, 1);
  assert.deepEqual(s.mails[0].body.to, [GUEST_EMAIL]);
  assert.ok(!s.mails[0].body.subject.includes('[TEST]') && !s.mails[0].body.text.includes('TEST'));
  assert.equal(s.mails[0].headers.get('idempotency-key')?.startsWith('reservation-confirmation-production-'), true);
  assert.deepEqual(confirmationRecipient({ BOOKING_ENV: 'production', BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX }, GUEST_EMAIL), { to: GUEST_EMAIL, test: false });
  assert.deepEqual(confirmationRecipient({ BOOKING_ENV: 'preview', BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX }, GUEST_EMAIL), { to: TEST_INBOX, test: true });
  assert.equal(confirmationRecipient({ BOOKING_ENV: 'preview' }, GUEST_EMAIL), null);
});

test('Preview bez testovací schránky nebo bez RESEND_API_KEY: rezervace 201, e-mail se přeskočí', async () => {
  for (const [env, log] of [
    [{ BOOKING_CONFIRMATION_TEST_EMAIL: undefined }, 'reservations: confirmation email skipped (no test recipient)'],
    [{ BOOKING_CONFIRMATION_TEST_EMAIL: '  ' }, 'reservations: confirmation email skipped (no test recipient)'],
    [{ RESEND_API_KEY: undefined }, 'reservations: confirmation email skipped (not configured)'],
  ] as const) {
    await preview.reset();
    const s = setup({ env });
    const response = await s.post(stay());
    assert.equal(response.status, 201);
    assert.equal(s.mails.length, 0);
    assert.equal(await s.t.count('reservations'), 1);
    assert.ok(s.logs.includes(log), JSON.stringify(s.logs));
  }
});

test('selhání Resend (HTTP 4xx/5xx, síť): rezervace zůstává, API vrátí 201, log bez osobních a bankovních údajů', async () => {
  const failures: [() => Response | Promise<Response>, string][] = [
    [() => Response.json({ message: `invalid to ${TEST_INBOX}` }, { status: 422 }), 'http-422'],
    [() => new Response('upstream error', { status: 500 }), 'http-500'],
    [() => Promise.reject(new TypeError('network down')), 'network'],
  ];
  for (const [resend, kind] of failures) {
    await preview.reset();
    const s = setup({ resend });
    const response = await s.post(stay());
    assert.equal(response.status, 201, kind);
    const body = (await response.json()) as ReservationResponse;
    assert.match(body.reservation.reservationCode, /^\d{8}$/);
    assert.equal(await s.t.count('reservations'), 1);
    assert.ok(s.logs.includes(`reservations: confirmation email failed (${kind})`), JSON.stringify(s.logs));
    const logText = s.logs.join('\n');
    for (const secret of PII) assert.ok(!logText.includes(secret), `${kind}: log obsahuje ${secret}`);
  }
});

test('odeslání je odložené (ctx.waitUntil): odpověď 201 nečeká na e-mail ani při jeho selhání', async () => {
  let release!: () => void;
  const s = setup({ defer: true, resend: () => new Promise<Response>((resolve) => (release = () => resolve(new Response('', { status: 503 })))) });
  const response = await s.post(stay());
  assert.equal(response.status, 201);
  assert.equal(s.deferred.length, 1);
  release();
  await Promise.all(s.deferred);
  assert.ok(s.logs.includes('reservations: confirmation email failed (http-503)'));
});

test('obsah e-mailu: stejná data jako odpověď API (kód, cena, VS, splatnost, SPAYD); HTML i text ve 4 jazycích', async () => {
  const s = setup();
  const api = (await (await s.post(stay())).json()) as ReservationResponse;
  const mail = s.mails[0].body;
  // E-mail používá serverová data z odpovědi API – nic se nepočítá znovu.
  assert.equal(api.payment.amountCzk, api.reservation.totalCzk);
  for (const value of [api.reservation.reservationCode, api.payment.variableSymbol, FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN]) {
    assert.ok(mail.html.includes(value) && mail.text.includes(value), value);
  }
  for (const locale of LOCALES) {
    const i18n = createI18n(locale as Locale);
    const email = renderConfirmationEmail(api, locale);
    const expected = [
      i18n.t('reservation.success.title'),
      i18n.t('email.confirmation.intro'),
      api.reservation.reservationCode,
      `${i18n.formatDate(api.reservation.arrival)} – ${i18n.formatDate(api.reservation.departure)}`,
      i18n.plural('booking.nights', api.reservation.nights),
      i18n.plural('booking.guests', api.reservation.guests),
      i18n.formatDeadlineDate(api.reservation.paymentDueAt),
      i18n.formatPrice(api.reservation.totalCzk),
      i18n.t('reservation.payment.amount'),
      i18n.t('reservation.payment.account'),
      FAKE_ACCOUNT_NUMBER,
      FAKE_PAYMENT_IBAN,
      i18n.t('reservation.payment.variableSymbol'),
      api.payment.variableSymbol,
    ];
    const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const value of expected) {
      assert.ok(email.text.includes(value), `${locale} text: ${value}`);
      assert.ok(email.html.includes(escape(value)), `${locale} html: ${value}`);
    }
    assert.equal(email.subject, i18n.t('email.confirmation.subject', { code: api.reservation.reservationCode }));
    // Bez skriptů, externích zdrojů a webfontů; jen inline styly.
    assert.doesNotMatch(email.html, /<script|<link|@import|https?:\/\/|<style/i);
    assert.ok(email.html.includes(`src="cid:${QR_CONTENT_ID}"`));
  }
  assert.ok(!mail.text.includes('<'), 'plaintext bez HTML');
});

test('QR v e-mailu: PNG inline příloha (cid) se stejným SPAYD jako API', async () => {
  const s = setup();
  const api = (await (await s.post(stay())).json()) as ReservationResponse;
  const [attachment] = s.mails[0].body.attachments!;
  assert.equal(attachment.content_id, QR_CONTENT_ID);
  assert.equal(attachment.filename, 'qr-platba.png');
  assert.equal(Buffer.from(attachment.content, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(decodeQrPng(attachment.content), qrMatrix(api.payment.spayd)!.data, 'moduly PNG = QR matice SPAYD z odpovědi API');
  assert.equal(api.payment.spayd, `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:${api.reservation.totalCzk}.00*CC:CZK*MSG:Rezervace ${api.reservation.reservationCode}*X-VS:${api.reservation.reservationCode}`);
});

test('HTML e-mailu escapuje hodnoty (adresa hosta v Preview poznámce)', () => {
  const api: ReservationResponse = {
    reservation: { reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, totalCzk: 8970, status: 'pending_payment', paymentDueAt: '2030-01-11T22:59:59.000Z' },
    payment: { amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001', dueAt: '2030-01-11T22:59:59.000Z', spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001` },
  };
  const email = renderConfirmationEmail(api, 'cs', { test: { originalRecipient: '"<b>x</b>"@example.invalid' } });
  assert.ok(!email.html.includes('<b>x</b>') && email.html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.equal(email.attachments.length, 1);
});
