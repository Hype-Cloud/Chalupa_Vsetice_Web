import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { qrMatrix, QR_QUIET_MODULES } from '../lib/booking/qr.ts';
import { createI18n, LOCALES, type Locale } from '../lib/i18n/index.ts';
import { BUSINESS, businessIdentity, phoneNumber } from '../lib/business.ts';
import { BRAND_ICON_CONTENT_ID, confirmationRecipient, confirmationSender, QR_CONTENT_ID, renderConfirmationEmail } from '../worker/booking/confirmation.ts';
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
const ADMIN_INBOX = 'spravce@example.invalid';
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

type Fake = () => Response | Promise<Response>;
const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

function setup(options: { env?: Partial<BookingEnv>; resend?: Fake; alertResend?: Fake; db?: 'preview' | 'production'; defer?: boolean } = {}) {
  const t = options.db === 'production' ? production : preview;
  const logs: string[] = [];
  const mails: SentMail[] = [];
  const deferred: Promise<unknown>[] = [];
  let uuid = 0;
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: options.db ?? 'preview', BOOKING_API_ENABLED: 'true',
    PAYMENT_IBAN: FAKE_PAYMENT_IBAN, TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
    RESEND_API_KEY: RESEND_KEY, BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX,
    CONFLICT_ALERT_EMAIL: ADMIN_INBOX,
    ...options.env,
  };
  const deps: BookingDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SITEVERIFY_URL) return Response.json({ success: true });
      if (url === RESEND_ENDPOINT) {
        const mail = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        mails.push(mail);
        const alert = mail.headers.get('idempotency-key')?.startsWith('confirmation-failure-alert-');
        const fake = alert ? options.alertResend : options.resend;
        return fake ? fake() : Response.json({ id: 'fake-email-id' });
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
  const kindOf = (m: SentMail) => (m.headers.get('idempotency-key')?.startsWith('confirmation-failure-alert-') ? 'alert' : 'confirmation');
  return { t, env, logs, mails, deferred, post, confirmations: () => mails.filter((m) => kindOf(m) === 'confirmation'), alerts: () => mails.filter((m) => kindOf(m) === 'alert') };
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

const PII = [GUEST_EMAIL, 'Testovací', 'Jan', '000 000', FAKE_PAYMENT_IBAN, FAKE_ACCOUNT_NUMBER, 'SPD*', TEST_INBOX, RESEND_KEY, ADMIN_INBOX];
/** Osobní a bankovní údaje, které nesmí být v interním upozornění. */
const ALERT_FORBIDDEN = [GUEST_EMAIL, 'Testovací', 'Jan ', '000 000', FAKE_PAYMENT_IBAN, FAKE_ACCOUNT_NUMBER, '1234567890', 'SPD*', 'Rezervace přijata', 'Přijedeme'];

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
  assert.equal(mail.body.from, 'Chalupa Všetice <rezervace@chalupavsetice.cz>');
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
    assert.equal(s.mails.length, 0, 'ani potvrzení, ani interní upozornění (konfigurace není selhání doručení)');
    assert.equal(await s.t.count('reservations'), 1);
    assert.ok(s.logs.includes(log), JSON.stringify(s.logs));
    assert.ok(!s.logs.some((l) => l.includes('alert')));
  }
});

test('selhání providera (timeout, síť, HTTP 4xx/5xx): rezervace 201, jeden pokus o interní upozornění bez osobních a bankovních údajů', async () => {
  const failures: [Fake, string][] = [
    [timeout, 'timeout'],
    [() => Promise.reject(new TypeError('network down')), 'network'],
    [() => Response.json({ message: `invalid to ${TEST_INBOX}` }, { status: 422 }), 'http-422'],
    [() => new Response('upstream error', { status: 500 }), 'http-500'],
  ];
  for (const [resend, kind] of failures) {
    await preview.reset();
    const s = setup({ resend });
    const response = await s.post(stay({ note: 'Přijedeme pozdě večer.' }));
    assert.equal(response.status, 201, kind);
    const body = (await response.json()) as ReservationResponse;
    const code = body.reservation.reservationCode;
    assert.match(code, /^\d{8}$/);
    assert.equal(await s.t.count('reservations'), 1);
    assert.equal(s.confirmations().length, 1, `${kind}: potvrzení se automaticky neopakuje`);
    assert.equal(s.alerts().length, 1, `${kind}: právě jedno interní upozornění`);
    const [alert] = s.alerts();
    assert.deepEqual(alert.body.to, [ADMIN_INBOX]);
    assert.equal(alert.body.subject, `[TEST] POZOR: potvrzovací e-mail rezervace ${code} selhal`);
    assert.equal(alert.headers.get('idempotency-key'), `confirmation-failure-alert-preview-${code}`);
    assert.ok(alert.body.text.includes(`Rezervace: ${code}`) && alert.body.text.includes('Prostředí: preview') && alert.body.text.includes(`Chyba: ${kind}`) && alert.body.text.includes(NOW.toISOString()));
    assert.equal(alert.body.html, undefined);
    assert.equal(alert.body.attachments, undefined);
    for (const value of ALERT_FORBIDDEN) assert.ok(!JSON.stringify(alert.body).includes(value), `${kind}: upozornění obsahuje ${value}`);
    assert.deepEqual(s.logs.filter((l) => l.includes('confirmation')), [`reservations: confirmation email failed (${kind})`, 'reservations: confirmation failure alert sent']);
    const logText = s.logs.join('\n');
    for (const secret of PII) assert.ok(!logText.includes(secret), `${kind}: log obsahuje ${secret}`);
  }
});

test('selhání interního upozornění: nic dalšího se nespouští, rezervace 201; bez adresy správce se upozornění jen přeskočí', async () => {
  for (const [alertResend, kind] of [[() => new Response('', { status: 503 }), 'http-503'], [timeout, 'timeout']] as [Fake, string][]) {
    await preview.reset();
    const s = setup({ resend: () => new Response('', { status: 500 }), alertResend });
    assert.equal((await s.post(stay())).status, 201);
    assert.equal(s.mails.length, 2, 'jedno potvrzení a jeden pokus o upozornění, žádná rekurze');
    assert.ok(s.logs.includes(`reservations: confirmation failure alert failed (${kind})`));
    assert.equal(await s.t.count('reservations'), 1);
  }
  await preview.reset();
  const s = setup({ resend: () => new Response('', { status: 500 }), env: { CONFLICT_ALERT_EMAIL: undefined } });
  assert.equal((await s.post(stay())).status, 201);
  assert.equal(s.mails.length, 1);
  assert.ok(s.logs.includes('reservations: confirmation failure alert skipped (not configured)'));
});

test('odesílatel z identity provozovatele (BUSINESS_NAME <BUSINESS_EMAIL_RESERVATIONS>) v Preview i v produkci', async () => {
  const expected = `${BUSINESS.BUSINESS_NAME} <${BUSINESS.BUSINESS_EMAIL_RESERVATIONS}>`;
  const p = setup();
  assert.equal((await p.post(stay())).status, 201);
  assert.equal(p.confirmations()[0].body.from, expected);
  const prod = setup({ db: 'production' });
  assert.equal((await prod.post(stay())).status, 201);
  assert.equal(prod.confirmations()[0].body.from, expected);
  assert.equal(confirmationSender(), expected);
  assert.equal(confirmationSender(businessIdentity({ ...BUSINESS, BUSINESS_NAME: 'Jiný objekt', BUSINESS_EMAIL_RESERVATIONS: 'booking@example.invalid' })), 'Jiný objekt <booking@example.invalid>');
});

test('business identity: jeden zdroj, telefon E.164 → tel: odkaz a český zápis; neplatné hodnoty odmítne', () => {
  const business = businessIdentity();
  assert.deepEqual(BUSINESS, {
    BUSINESS_NAME: 'Chalupa Všetice',
    BUSINESS_PHONE: '+420736125104',
    BUSINESS_ICO: '23380811',
    BUSINESS_REGISTER_URL: 'https://ares.gov.cz/ekonomicke-subjekty/res/23380811',
    BUSINESS_EMAIL_INFO: 'info@chalupavsetice.cz',
    BUSINESS_EMAIL_RESERVATIONS: 'rezervace@chalupavsetice.cz',
  });
  assert.deepEqual(business.phone, { e164: '+420736125104', href: 'tel:+420736125104', national: '736 125 104', international: '+420 736 125 104' });
  assert.deepEqual(phoneNumber('+420 000 000 000'), { e164: '+420000000000', href: 'tel:+420000000000', national: '000 000 000', international: '+420 000 000 000' });
  assert.equal(phoneNumber('+4930123456').national, '+4930123456');
  for (const bad of [{ BUSINESS_PHONE: '736125104' }, { BUSINESS_ICO: '123' }, { BUSINESS_EMAIL_INFO: 'nic' }, { BUSINESS_NAME: 'A <b>' }, { BUSINESS_REGISTER_URL: 'http://x.invalid' }]) {
    assert.throws(() => businessIdentity({ ...BUSINESS, ...bad }), RangeError, JSON.stringify(bad));
  }
});

test('věta o e-mailu ve success panelu: nové znění ve 4 jazycích', () => {
  assert.deepEqual(Object.fromEntries(LOCALES.map((l) => [l, createI18n(l).t('reservation.success.emailInfo')])), {
    cs: 'Potvrzení a platební údaje vám posíláme také e-mailem.',
    en: 'We are also sending you the confirmation and payment details by email.',
    de: 'Die Bestätigung und die Zahlungsdaten senden wir Ihnen auch per E-Mail.',
    ua: 'Підтвердження та платіжні реквізити ми також надсилаємо вам електронною поштою.',
  });
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
    const email = renderConfirmationEmail(api, locale, { createdAt: NOW.toISOString() });
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
    // Bez skriptů, externích zdrojů a webfontů; jen inline styly. Obrázky jen cid:, odkazy jen
    // tel:, mailto: a rejstřík provozovatele.
    assert.doesNotMatch(email.html, /<script|<link|@import|<style|url\(/i);
    assert.deepEqual([...email.html.matchAll(/src="([^"]*)"/g)].map((m) => m[1]), [`cid:${BRAND_ICON_CONTENT_ID}`, `cid:${QR_CONTENT_ID}`]);
    assert.deepEqual([...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ['tel:+420736125104', 'mailto:info@chalupavsetice.cz', BUSINESS.BUSINESS_REGISTER_URL]);
  }
  assert.ok(!mail.text.includes('<'), 'plaintext bez HTML');
});

test('QR v e-mailu: PNG inline příloha (cid) se stejným SPAYD jako API', async () => {
  const s = setup();
  const api = (await (await s.post(stay())).json()) as ReservationResponse;
  const attachment = s.mails[0].body.attachments!.find((a) => a.content_id === QR_CONTENT_ID)!;
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
  const email = renderConfirmationEmail(api, 'cs', { createdAt: NOW.toISOString(), test: { originalRecipient: '"<b>x</b>"@example.invalid' } });
  assert.ok(!email.html.includes('<b>x</b>') && email.html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.deepEqual(email.attachments.map((a) => a.contentId), [BRAND_ICON_CONTENT_ID, QR_CONTENT_ID]);
});

/** Viditelný text HTML (bez značek, hodnot atributů a entit). */
const visibleText = (html: string) =>
  html.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const SAMPLE: ReservationResponse = {
  reservation: { reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, totalCzk: 8970, status: 'pending_payment', paymentDueAt: '2030-01-11T22:59:59.000Z' },
  payment: { amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001', dueAt: '2030-01-11T22:59:59.000Z', spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001` },
};

test('hlavička: BUSINESS_NAME, ikona (cid) a datum vytvoření rezervace (ne termín pobytu) ve 4 jazycích', () => {
  // Vytvořeno 10. 1. 2030 23:30 UTC = 11. 1. 2030 v Praze.
  const createdAt = '2030-01-10T23:30:00.000Z';
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(SAMPLE, locale, { createdAt });
    const header = email.html.slice(0, email.html.indexOf('<h1'));
    const received = i18n.t('email.header.received', { date: i18n.formatDeadlineDate(createdAt) });
    assert.ok(header.includes(BUSINESS.BUSINESS_NAME), locale);
    assert.ok(header.includes(`src="cid:${BRAND_ICON_CONTENT_ID}"`), locale);
    assert.ok(header.includes(received) && received.includes(i18n.formatDeadlineDate('2030-01-11T12:00:00Z')), `${locale}: ${received}`);
    assert.ok(email.text.includes(`${BUSINESS.BUSINESS_NAME} · ${received}`), locale);
  }
  const icon = renderConfirmationEmail(SAMPLE, 'cs', { createdAt }).attachments.find((a) => a.contentId === BRAND_ICON_CONTENT_ID)!;
  const png = Buffer.from(icon.content, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [72, 72]);
});

test('platba: nadpis → instrukce (splatnost, celá částka, VS) → QR bez popisku → ruční údaje; telefonický kontakt a patička', () => {
  const email = renderConfirmationEmail(SAMPLE, 'cs', { createdAt: NOW.toISOString() });
  const order = ['Rezervace přijata', 'Celková cena', 'Platební údaje', 'Prosíme o úhradu celé částky do 11. 1. 2030. Pro platbu použijte variabilní symbol 10013001.', `cid:${QR_CONTENT_ID}`, 'Číslo účtu', 'Potřebujete se na něčem domluvit?', 'Rádi vám poradíme po telefonu.', 'Zavolat 736 125 104', 'info@chalupavsetice.cz', 'IČO: 23380811'];
  const positions = order.map((value) => email.html.indexOf(value));
  assert.ok(positions.every((p) => p >= 0), JSON.stringify(Object.fromEntries(order.map((v, i) => [v, positions[i]]))));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'pořadí sekcí');
  assert.ok(email.html.includes('alt="Platební QR kód"'));
  assert.ok(!email.html.includes('naskenujte') && !email.text.includes('QR Platba'), 'bez popisku „QR Platba – naskenujte…“');
  // CTA: kanonický tel: odkaz a zobrazení z konfigurace.
  assert.match(email.html, /<a href="tel:\+420736125104"[^>]*>.*Zavolat 736 125 104<\/a>/);
  // Patička: celé „IČO: …“ je odkaz přesně na BUSINESS_REGISTER_URL; žádné ARES ani viditelná URL.
  assert.ok(email.html.includes(`<a href="${BUSINESS.BUSINESS_REGISTER_URL}" style="color:#5c6a63;text-decoration:underline;">IČO: ${BUSINESS.BUSINESS_ICO}</a>`));
  assert.ok(email.html.includes(`href="mailto:${BUSINESS.BUSINESS_EMAIL_INFO}"`));
  const visible = visibleText(email.html);
  assert.doesNotMatch(visible, /ARES|rejstřík|https?:\/\/|ares\.gov/i);
  assert.doesNotMatch(email.text, /ARES|https?:\/\//i);
});

test('CTA, patička a plaintext ve 4 jazycích: kontakty z konfigurace (telefon, info e-mail, IČO)', () => {
  const business = businessIdentity();
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(SAMPLE, locale, { createdAt: NOW.toISOString() });
    const phone = locale === 'cs' ? '736 125 104' : '+420 736 125 104';
    const call = i18n.t('email.cta.call', { phone });
    for (const value of [i18n.t('email.cta.heading'), i18n.t('email.cta.text'), call, business.emailInfo, `IČO: ${business.ico}`, i18n.t('email.paymentNote', { date: i18n.formatDeadlineDate(SAMPLE.payment.dueAt), vs: '10013001' })]) {
      assert.ok(email.text.includes(value), `${locale} text: ${value}`);
      assert.ok(visibleText(email.html).includes(value), `${locale} html: ${value}`);
    }
    assert.ok(email.html.includes('href="tel:+420736125104"'), locale);
    assert.ok(!email.text.includes(business.emailReservations), `${locale}: veřejný kontakt je info@, ne odesílatel`);
  }
});

test('renderer nemá napevno údaje provozovatele: jiná konfigurace se propíše všude', () => {
  for (const file of ['worker/booking/confirmation.ts', 'worker/email/brandIcon.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    for (const value of ['Chalupa Všetice', 'chalupavsetice.cz', '736', '23380811', 'ares.gov.cz']) assert.ok(!source.includes(value), `${file}: ${value}`);
  }
  const other = businessIdentity({
    BUSINESS_NAME: 'Testovací Roubenka', BUSINESS_PHONE: '+420000111222', BUSINESS_ICO: '00000019',
    BUSINESS_REGISTER_URL: 'https://rejstrik.invalid/00000019', BUSINESS_EMAIL_INFO: 'info@roubenka.invalid', BUSINESS_EMAIL_RESERVATIONS: 'rezervace@roubenka.invalid',
  });
  const email = renderConfirmationEmail(SAMPLE, 'cs', { createdAt: NOW.toISOString(), business: other });
  for (const value of ['Testovací Roubenka', 'tel:+420000111222', 'Zavolat 000 111 222', 'mailto:info@roubenka.invalid', 'href="https://rejstrik.invalid/00000019"', 'IČO: 00000019']) assert.ok(email.html.includes(value), value);
  for (const value of ['Chalupa Všetice', 'chalupavsetice', '736 125 104', '23380811']) assert.ok(!email.html.includes(value) && !email.text.includes(value), value);
});
