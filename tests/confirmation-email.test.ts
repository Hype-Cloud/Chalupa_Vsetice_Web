import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { qrMatrix, QR_QUIET_MODULES } from '../lib/booking/qr.ts';
import { createI18n, LOCALES, type Locale } from '../lib/i18n/index.ts';
import { BUSINESS, businessIdentity, phoneNumber } from '../lib/business.ts';
import { BRAND_MARK_CONTENT_ID, confirmationRecipient, sendReservationConfirmation, PHONE_ICON_CONTENT_ID, PHONE_ICON_DARK_CONTENT_ID, confirmationSender, QR_CONTENT_ID, renderConfirmationEmail } from '../worker/booking/confirmation.ts';
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

/** Interní UUID n-té vygenerované rezervace v setup() (deterministické randomUUID). */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const storedId = async (t: { db: D1Database }, code: string) =>
  (await t.db.prepare('SELECT id FROM reservations WHERE public_code = ?1').bind(code).first<{ id: string }>())!.id;

test('nová rezervace v Preview: 201, jeden záznam, jeden e-mail na testovací schránku; klíč idempotence = interní UUID', async () => {
  const s = setup();
  const first = await s.post(stay({ locale: 'de' }), { 'idempotency-key': 'potvrzeni-0000000000000001' });
  assert.equal(first.status, 201);
  const api = (await first.json()) as ReservationResponse;
  assert.equal(await s.t.count('reservations'), 1);
  assert.equal(s.mails.length, 1);
  const [mail] = s.mails;
  assert.deepEqual(mail.body.to, [TEST_INBOX], 'v Preview nikdy na adresu hosta');
  assert.equal(mail.body.from, 'Chalupa Všetice <rezervace@chalupavsetice.cz>');
  assert.equal(mail.body.subject, `[TEST] Buchung eingegangen – ${api.reservation.reservationCode}`);
  assert.equal(mail.headers.get('authorization'), `Bearer ${RESEND_KEY}`);
  const id = await storedId(s.t, api.reservation.reservationCode);
  assert.equal(id, uuid(1));
  assert.equal(mail.headers.get('idempotency-key'), `reservation-confirmation-preview-${id}`);
  // Obsah je stejný jako v produkci: žádný Preview banner ani adresa hosta v těle.
  assert.ok(!mail.body.text.includes(GUEST_EMAIL) && !mail.body.html.includes(GUEST_EMAIL), 'adresa hosta není v těle');
  assert.doesNotMatch(mail.body.html + mail.body.text, /TEST \(Preview\)|v produkci by/);
  assert.equal((await s.t.db.prepare('SELECT locale FROM reservations').first<{ locale: string }>())!.locale, 'de');
});

test('replay (stejný Idempotency-Key): 200 + replayed, stejná rezervace, potvrzení znovu naplánované se stejným klíčem; e-mail a jazyk z uložené rezervace', async () => {
  const s = setup({ defer: true });
  const key = { 'idempotency-key': 'potvrzeni-0000000000000003' };
  const first = await s.post(stay({ locale: 'de' }), key);
  assert.equal(first.status, 201);
  const api = (await first.json()) as ReservationResponse;
  // Opakovaný požadavek s jiným jazykem webu (locale není v otisku požadavku).
  const replay = await s.post(stay({ locale: 'en' }), key);
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()) as ReservationResponse & { replayed?: boolean };
  assert.equal(replayed.replayed, true);
  assert.deepEqual({ ...replayed, replayed: undefined }, { ...api, replayed: undefined });
  assert.equal(await s.t.count('reservations'), 1);
  assert.equal(s.deferred.length, 2, 'potvrzení naplánované i pro replay (ctx.waitUntil)');
  await Promise.all(s.deferred);
  const keys = s.confirmations().map((m) => m.headers.get('idempotency-key'));
  assert.deepEqual(keys, [`reservation-confirmation-preview-${uuid(1)}`, `reservation-confirmation-preview-${uuid(1)}`], 'stejný klíč → Resend nezdvojí');
  const second = s.confirmations()[1].body;
  assert.ok(second.subject.includes('Buchung eingegangen'), 'jazyk uložený u rezervace, ne z opakovaného požadavku');
  // Produkce: příjemce replay = uložený e-mail hosta.
  const prod = setup({ db: 'production' });
  await prod.post(stay(), key);
  await prod.post(stay(), key);
  assert.deepEqual(prod.confirmations().map((m) => m.body.to), [[GUEST_EMAIL], [GUEST_EMAIL]]);
});

test('souběžný dvojklik (UNIQUE idempotency_key po INSERTu): jedna rezervace, oba požadavky plánují potvrzení se stejným klíčem', async () => {
  const s = setup();
  const key = { 'idempotency-key': 'potvrzeni-0000000000000002' };
  const pair = await Promise.all([s.post(stay(), key), s.post(stay(), key)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 201]);
  assert.equal(await s.t.count('reservations'), 1);
  const id = (await s.t.db.prepare('SELECT id FROM reservations').first<{ id: string }>())!.id;
  assert.deepEqual(s.confirmations().map((m) => m.headers.get('idempotency-key')), [`reservation-confirmation-preview-${id}`, `reservation-confirmation-preview-${id}`]);
});

test('replay bez e-mailu: jiný otisk požadavku (422), zrušená rezervace, rezervace bez uloženého jazyka', async () => {
  const s = setup();
  const key = { 'idempotency-key': 'potvrzeni-0000000000000004' };
  await s.post(stay(), key);
  assert.equal((await s.post(stay({ guests: 3 }), key)).status, 422);
  assert.equal(s.mails.length, 1);
  await s.t.db.prepare('UPDATE reservations SET locale = NULL').run();
  assert.equal((await s.post(stay(), key)).status, 200);
  await s.t.db.prepare("UPDATE reservations SET status = 'cancelled'").run();
  assert.equal((await s.post(stay(), key)).status, 200);
  assert.equal(s.mails.length, 1, 'žádné další potvrzení');
});

test('dvě rezervace se stejným veřejným kódem (úklid Preview DB, reset čítače): různé UUID → různé klíče u Resend', async () => {
  const s = setup();
  const a = (await (await s.post(stay())).json()) as ReservationResponse;
  // Ruční úklid Preview: smazané rezervace i denní čítač → další rezervace dostane stejný kód.
  await s.t.db.batch([s.t.db.prepare('DELETE FROM reservations'), s.t.db.prepare('DELETE FROM reservation_code_counters')]);
  const b = (await (await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-04' }))).json()) as ReservationResponse;
  assert.equal(a.reservation.reservationCode, b.reservation.reservationCode);
  const keys = s.confirmations().map((m) => m.headers.get('idempotency-key'));
  assert.deepEqual(keys, [`reservation-confirmation-preview-${uuid(1)}`, `reservation-confirmation-preview-${uuid(2)}`]);
});

test('interní UUID je jen pro server: není v odpovědi API, HTML, plaintextu ani logu', async () => {
  const s = setup({ resend: () => new Response('', { status: 500 }) });
  const key = { 'idempotency-key': 'potvrzeni-0000000000000005' };
  const responses = [await s.post(stay(), key), await s.post(stay(), key)];
  const id = uuid(1);
  for (const r of responses) assert.ok(!(await r.text()).includes(id), 'API');
  for (const m of s.confirmations()) {
    assert.ok(!m.body.html.includes(id) && !m.body.text.includes(id) && !m.body.subject.includes(id), 'e-mail');
  }
  for (const m of s.alerts()) {
    assert.equal(m.headers.get('idempotency-key'), `confirmation-failure-alert-preview-${id}`);
    assert.ok(!JSON.stringify(m.body).includes(id), 'text upozornění');
  }
  assert.ok(!s.logs.join('\n').includes(id), 'log');
  assert.ok(!s.logs.join('\n').includes('0000-4000-8000'), 'log');
});

test('potvrzení nic nedělá synchronně: Promise se vrátí dřív, než proběhne render nebo síť', async () => {
  const calls: string[] = [];
  const pending = sendReservationConfirmation(
    { BOOKING_ENV: 'preview', RESEND_API_KEY: RESEND_KEY, BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX },
    SAMPLE,
    { reservationId: uuid(9), guestEmail: GUEST_EMAIL, locale: 'cs' },
    { fetch: (async () => (calls.push('fetch'), Response.json({ id: 'x' }))) as typeof fetch, log: (m) => calls.push(m), now: () => NOW },
  );
  assert.deepEqual(calls, [], 'před předáním do ctx.waitUntil neproběhlo nic');
  assert.equal(await pending, 'sent');
  assert.deepEqual(calls, ['fetch', 'reservations: confirmation email sent']);
});

test('statické ikony e-mailu jsou předgenerované: Worker je nerastruje, soubor odpovídá generátoru', async () => {
  const root = join(import.meta.dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  for (const file of [...sources('worker'), ...sources('lib')]) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(!/from '[^']*(scripts\/|email-icons)|pathToPolylines|strokeCoverage|brandMarkPng|phoneIconPng/.test(source), `${file}: rastrování ikon v kódu Workeru`);
  }
  const { iconAssetsSource, ICON_ASSETS_PATH } = await import('../scripts/email-icons.ts');
  assert.equal(readFileSync(ICON_ASSETS_PATH, 'utf8'), iconAssetsSource(), 'worker/email/iconAssets.ts je zastaralý: pnpm run email:icons');
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
    assert.equal(alert.headers.get('idempotency-key'), `confirmation-failure-alert-preview-${await storedId(s.t, code)}`);
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
    BUSINESS_WEBSITE_URL: 'https://chalupavsetice.cz',
    BUSINESS_EMAIL_INFO: 'info@chalupavsetice.cz',
    BUSINESS_EMAIL_RESERVATIONS: 'rezervace@chalupavsetice.cz',
  });
  assert.deepEqual(business.phone, { e164: '+420736125104', href: 'tel:+420736125104', national: '736 125 104', international: '+420 736 125 104' });
  assert.deepEqual(phoneNumber('+420 000 000 000'), { e164: '+420000000000', href: 'tel:+420000000000', national: '000 000 000', international: '+420 000 000 000' });
  assert.equal(phoneNumber('+4930123456').national, '+4930123456');
  for (const bad of [{ BUSINESS_PHONE: '736125104' }, { BUSINESS_ICO: '123' }, { BUSINESS_EMAIL_INFO: 'nic' }, { BUSINESS_NAME: 'A <b>' }, { BUSINESS_WEBSITE_URL: 'http://x.invalid' }, { BUSINESS_WEBSITE_URL: 'https://a"b.invalid' }]) {
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
    assert.ok(mail.html.replaceAll('<wbr>', '').includes(value) && mail.text.includes(value), value);
  }
  for (const locale of LOCALES) {
    const i18n = createI18n(locale as Locale);
    const email = renderConfirmationEmail(api, locale);
    const expected = [
      i18n.t('reservation.success.title'),
      i18n.t('email.confirmation.intro', { date: i18n.formatDeadlineDate(api.payment.dueAt) }),
      i18n.t('email.summaryHeading'),
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
      assert.ok(email.html.replaceAll('<wbr>', '').includes(escape(value)), `${locale} html: ${value}`);
    }
    assert.equal(email.subject, i18n.t('email.confirmation.subject', { code: api.reservation.reservationCode }));
    // Bez skriptů, externích zdrojů a webfontů; vložené <style> jen jako vylepšení. Obrázky
    // jen cid:, odkazy jen tel:, mailto: a rejstřík provozovatele.
    assert.doesNotMatch(email.html, /<script|<link|@import|@font-face|url\(/i);
    assert.deepEqual([...email.html.matchAll(/src="([^"]*)"/g)].map((m) => m[1]), [BRAND_MARK_CONTENT_ID, QR_CONTENT_ID, PHONE_ICON_CONTENT_ID, PHONE_ICON_DARK_CONTENT_ID].map((id) => `cid:${id}`));
    assert.deepEqual([...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ['tel:+420736125104', 'https://chalupavsetice.cz', 'mailto:info@chalupavsetice.cz']);
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

test('HTML e-mailu escapuje hodnoty; Preview má stejný obsah jako produkce, jen [TEST] v předmětu', () => {
  const api: ReservationResponse = {
    reservation: { reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, totalCzk: 8970, status: 'pending_payment', paymentDueAt: '2030-01-11T22:59:59.000Z' },
    payment: { amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001', dueAt: '2030-01-11T22:59:59.000Z', spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001` },
  };
  const business = businessIdentity({ ...BUSINESS, BUSINESS_NAME: "Chalupa & Co 'Test'" });
  const email = renderConfirmationEmail(api, 'cs', { test: true, business });
  assert.ok(!email.html.includes("Chalupa & Co 'Test'") && email.html.includes('Chalupa &amp; Co &#39;Test&#39;'));
  const production = renderConfirmationEmail(api, 'cs', { business });
  assert.equal(email.subject, `[TEST] ${production.subject}`);
  assert.equal(email.text, production.text);
  assert.equal(email.html.replace(/<title>[^<]*<\/title>/, ''), production.html.replace(/<title>[^<]*<\/title>/, ''));
  assert.deepEqual(email.attachments.map((a) => a.contentId), [BRAND_MARK_CONTENT_ID, PHONE_ICON_CONTENT_ID, PHONE_ICON_DARK_CONTENT_ID, QR_CONTENT_ID]);
});

/** Viditelný text HTML (bez značek, hodnot atributů a entit). */
const visibleText = (html: string) =>
  html.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const SAMPLE: ReservationResponse = {
  reservation: { reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, totalCzk: 8970, status: 'pending_payment', paymentDueAt: '2030-01-11T22:59:59.000Z' },
  payment: { amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001', dueAt: '2030-01-11T22:59:59.000Z', spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001` },
};

test('hlavička: BUSINESS_NAME, značka (cid) a termín pobytu (ne datum vytvoření) ve 4 jazycích', () => {
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(SAMPLE, locale);
    const header = email.html.slice(email.html.indexOf('<body'), email.html.indexOf('<h1'));
    const stay = i18n.formatDateRange(SAMPLE.reservation.arrival, SAMPLE.reservation.departure);
    const name = visibleText(header);
    assert.ok(name.includes('Chalupa') && name.includes('Všetice'), locale);
    assert.ok(header.includes(`src="cid:${BRAND_MARK_CONTENT_ID}"`), locale);
    assert.ok(header.includes(stay), `${locale}: ${stay}`);
    // Splatnost (11. 1. 2030) ani žádné jiné datum než termín v hlavičce není.
    assert.ok(!header.includes(i18n.formatDeadlineDate(SAMPLE.reservation.paymentDueAt)), locale);
    assert.ok(email.text.includes(`${BUSINESS.BUSINESS_NAME} · ${stay}`), locale);
  }
  // Domek: průhledné PNG (tRNS) přímo na pozadí hlavičky – buňka ikony nemá vlastní pozadí,
  // rámeček ani zaoblení; tmavý režim hlavičku ani ikonu nepřebarvuje.
  const html = renderConfirmationEmail(SAMPLE, 'cs').html;
  const mark = Buffer.from(renderConfirmationEmail(SAMPLE, 'cs').attachments.find((a) => a.contentId === BRAND_MARK_CONTENT_ID)!.content, 'base64');
  assert.equal(mark.subarray(1, 4).toString(), 'PNG');
  assert.ok(mark.indexOf('tRNS') > 0, 'průhledné pozadí');
  const iconCell = /<td[^>]*>(?=<img src="cid:znacka")/.exec(html)![0];
  assert.doesNotMatch(iconCell + /<img src="cid:znacka"[^>]*>/.exec(html)![0], /bgcolor|background|border:[^0]|border-radius|padding:[1-9]/);
  assert.doesNotMatch(/@media \(prefers-color-scheme:dark\)\{[^}]*(\}[^}]*)*?\}\}/.exec(html)?.[0] ?? '', /e-header|e-brand|znacka/);
  // Jméno jednotnou vahou: žádné zvýraznění prvního slova.
  const brand = /<td[^>]*class="e-brand"[^>]*>(.*?)<\/td>/.exec(html)!;
  assert.equal(brand[1], BUSINESS.BUSINESS_NAME);
  assert.match(brand[0], /font-weight:normal/);
  assert.doesNotMatch(brand[0], /<b\b|<strong|bold/);
});

test('termín pobytu v hlavičce: kompaktně, den → měsíc → rok, jednoznačně přes měsíc i rok', () => {
  const ranges = (from: string, to: string) => Object.fromEntries(LOCALES.map((l) => [l, createI18n(l).formatDateRange(from, to)]));
  assert.deepEqual(ranges('2026-12-02', '2026-12-04'), { cs: '2.–4. 12. 2026', en: '2–4 Dec 2026', de: '2.–4.12.2026', ua: '02.–04.12.2026' });
  assert.deepEqual(ranges('2026-11-29', '2026-12-02'), { cs: '29. 11. – 2. 12. 2026', en: '29 Nov – 2 Dec 2026', de: '29.11. – 2.12.2026', ua: '29.11. – 02.12.2026' });
  assert.deepEqual(ranges('2026-12-30', '2027-01-02'), { cs: '30. 12. 2026 – 2. 1. 2027', en: '30 Dec 2026 – 2 Jan 2027', de: '30.12.2026 – 2.1.2027', ua: '30.12.2026 – 02.01.2027' });
});

test('úvod (splatnost, instrukce před příjezdem, kontakt) → Souhrn rezervace → Platební údaje (QR, ruční údaje) → kontakt → patička', () => {
  const email = renderConfirmationEmail(SAMPLE, 'cs');
  const intro = 'Děkujeme za rezervaci. Prosíme o úhradu celé částky do 11. 1. 2030. Před příjezdem vám ještě zašleme podrobnější instrukce k pobytu. V případě jakýchkoli dotazů nás neváhejte kontaktovat.';
  const order = ['Rezervace přijata', intro, '>Souhrn rezervace</h2>', 'Celková cena', 'Platební údaje', `cid:${QR_CONTENT_ID}`, 'Číslo účtu', 'Potřebujete se na něčem domluvit?', 'Rádi vám poradíme po telefonu.', 'Zavolat 736 125 104', 'info@chalupavsetice.cz', 'IČ: 23380811'];
  const positions = order.map((value) => email.html.indexOf(value));
  assert.ok(positions.every((p) => p >= 0), JSON.stringify(Object.fromEntries(order.map((v, i) => [v, positions[i]]))));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'pořadí sekcí');
  assert.ok(email.html.includes('alt="Platební QR kód"'));
  assert.ok(!email.html.includes('naskenujte') && !email.text.includes('QR Platba'), 'bez popisku „QR Platba – naskenujte…“');
  // CTA: kanonický tel: odkaz a zobrazení z konfigurace.
  assert.match(email.html, /<a href="tel:\+420736125104"[^>]*>(?:(?!<\/a>).)*Zavolat 736 125 104<\/span><\/a>/);
  assert.ok(email.text.includes(intro));
  // Variabilní symbol ani splatnost se v platební sekci textem neopakují.
  assert.ok(!email.html.includes('Pro platbu použijte variabilní symbol') && !email.text.includes('Pro platbu použijte variabilní symbol'));
  const payment = email.html.slice(email.html.indexOf('Platební údaje'), email.html.indexOf(`cid:${QR_CONTENT_ID}`));
  assert.doesNotMatch(payment, /<p\b/, 'mezi nadpisem a QR žádný textový odstavec');
  // Patička: jméno → web, info e-mail → mailto, IČ prostý text; žádný registr.
  const links = [...email.html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => ({ href, label }));
  assert.deepEqual(links, [
    { href: BUSINESS.BUSINESS_WEBSITE_URL, label: BUSINESS.BUSINESS_NAME },
    { href: `mailto:${BUSINESS.BUSINESS_EMAIL_INFO}`, label: BUSINESS.BUSINESS_EMAIL_INFO },
  ]);
  const footer = email.html.slice(email.html.indexOf('class="e-foot'));
  assert.match(footer, /<td class="e-item"[^>]*>IČ: 23380811<\/td>/, 'IČ jako prostý text, ne <a>');
  assert.doesNotMatch(email.html, /ares\.gov|ARES/);
  assert.ok(!email.html.includes('IČO') && !email.text.includes('IČO'));
  // Tmavý režim jen jako vylepšení: e-mail ho deklaruje, výchozí (inline) stav je světlý
  // a tmavá varianta ikony je bez podpory <style> skrytá.
  assert.ok(email.html.includes('<meta name="color-scheme" content="light dark">'));
  assert.match(email.html, /<img class="e-ico-dark" src="cid:telefon-tmavy"[^>]*style="display:none;/);
  assert.ok(email.html.includes(`href="mailto:${BUSINESS.BUSINESS_EMAIL_INFO}"`));
  const visible = visibleText(email.html);
  assert.doesNotMatch(visible, /ARES|rejstřík|ověřit|https?:\/\/|ares\.gov/i);
  assert.ok(!visible.includes(BUSINESS.BUSINESS_EMAIL_RESERVATIONS), 'odesílatel rezervací se v patičce nezobrazuje');
  assert.doesNotMatch(email.text, /ARES|https?:\/\//i);
});

test('CTA, patička a plaintext ve 4 jazycích: kontakty z konfigurace (telefon, info e-mail, IČ)', () => {
  const business = businessIdentity();
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(SAMPLE, locale);
    const phone = locale === 'cs' ? '736 125 104' : '+420 736 125 104';
    const call = i18n.t('email.cta.call', { phone });
    const intro = i18n.t('email.confirmation.intro', { date: i18n.formatDeadlineDate(SAMPLE.payment.dueAt) });
    assert.ok(intro.includes(i18n.formatDeadlineDate(SAMPLE.payment.dueAt)), `${locale}: splatnost v úvodu`);
    for (const value of [intro, i18n.t('email.summaryHeading'), i18n.t('email.cta.heading'), i18n.t('email.cta.text'), call, business.name, business.emailInfo, `IČ: ${business.ico}`]) {
      assert.ok(email.text.includes(value), `${locale} text: ${value}`);
      assert.ok(visibleText(email.html).includes(value), `${locale} html: ${value}`);
    }
    assert.ok(email.html.includes('href="tel:+420736125104"'), locale);
    assert.ok(!email.text.includes(business.emailReservations), `${locale}: veřejný kontakt je info@, ne odesílatel`);
  }
});

test('renderer nemá napevno údaje provozovatele: jiná konfigurace se propíše všude', () => {
  for (const file of ['worker/booking/confirmation.ts', 'worker/email/iconAssets.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    for (const value of ['Chalupa Všetice', 'chalupavsetice.cz', '736', '23380811', 'ares.gov.cz', 'https://']) assert.ok(!source.includes(value), `${file}: ${value}`);
  }
  const other = businessIdentity({
    BUSINESS_NAME: 'Testovací Roubenka', BUSINESS_PHONE: '+420000111222', BUSINESS_ICO: '00000019',
    BUSINESS_WEBSITE_URL: 'https://roubenka.invalid', BUSINESS_EMAIL_INFO: 'info@roubenka.invalid', BUSINESS_EMAIL_RESERVATIONS: 'rezervace@roubenka.invalid',
  });
  const email = renderConfirmationEmail(SAMPLE, 'cs', { business: other });
  for (const value of ['Testovací Roubenka', 'tel:+420000111222', 'Zavolat 000 111 222', 'mailto:info@roubenka.invalid', 'href="https://roubenka.invalid"', 'IČ: 00000019']) assert.ok(email.html.includes(value), value);
  for (const value of ['Chalupa Všetice', 'chalupavsetice', '736 125 104', '23380811']) assert.ok(!email.html.includes(value) && !email.text.includes(value), value);
});

test('BUSINESS_REGISTER_URL ani odkaz na ARES už v runtime konfiguraci ani dokumentaci nejsou', () => {
  const root = join(import.meta.dirname, '..');
  assert.ok(!('BUSINESS_REGISTER_URL' in BUSINESS));
  assert.ok(!('registerUrl' in businessIdentity()));
  for (const file of ['lib/business.ts', 'worker/booking/confirmation.ts', 'README.md', 'CLAUDE.md', 'wrangler.jsonc']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, /REGISTER_URL|registerUrl|ares\.gov/, file);
  }
});

test('úvod bez věty o souhrnu, nadpis „Souhrn rezervace“ ve 4 jazycích na stejné úrovni jako „Platební údaje“', () => {
  const headings = { cs: 'Souhrn rezervace', en: 'Booking summary', de: 'Buchungsübersicht', ua: 'Підсумок бронювання' };
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(SAMPLE, locale);
    assert.equal(i18n.t('email.summaryHeading'), headings[locale]);
    const h2 = [...email.html.matchAll(/<h2 ([^>]*)>([^<]*)<\/h2>/g)];
    assert.deepEqual(h2.map((m) => m[2]), [headings[locale], i18n.t('reservation.payment.details')], locale);
    // Stejný styl obou nadpisů (serif, normální váha, tmavě zelená) – liší se jen okraje.
    const style = (m: RegExpMatchArray) => m[1].replace(/margin:[^;]*;/, '');
    assert.equal(style(h2[0]), style(h2[1]));
    assert.match(h2[0][1], /Georgia[^"]*font-weight:normal[^"]*color:#163d33/);
    // Úvod končí kontaktní větou; věta o souhrnu nikde.
    assert.ok(email.text.includes(`${i18n.t('email.confirmation.intro', { date: i18n.formatDeadlineDate(SAMPLE.payment.dueAt) })}\n\n${headings[locale]}`), locale);
  }
  const cs = renderConfirmationEmail(SAMPLE, 'cs');
  assert.ok(!cs.html.includes('Níže najdete') && !cs.text.includes('Níže najdete'));
  assert.ok(createI18n('cs').t('email.confirmation.intro', { date: 'X' }).endsWith('V případě jakýchkoli dotazů nás neváhejte kontaktovat.'));
  // Mezi souhrnem a platbou jemná linka v barvě ohraničení.
  assert.match(cs.html, /<div class="e-line" style="[^"]*border-top:1px solid #e2e7e0;[^"]*"><h2[^>]*>Platební údaje<\/h2>/);
});

test('platba: na desktopu QR vlevo a údaje vpravo ve vnořené tabulce, na mobilu (media query) pod sebou; IBAN se láme bezpečně', () => {
  const email = renderConfirmationEmail(SAMPLE, 'cs');
  const section = email.html.slice(email.html.indexOf('>Platební údaje</h2>'), email.html.indexOf('Těšíme se'));
  // Jeden řádek vnořené tabulky: buňka s QR, pak buňka s údaji (svisle na střed).
  const cells = [...section.matchAll(/<td class="(e-pay-qr|e-pay-details)"([^>]*)>/g)];
  assert.deepEqual(cells.map((m) => m[1]), ['e-pay-qr', 'e-pay-details']);
  assert.match(section, /<table role="presentation" class="e-pay" width="100%"[^>]*><tr><td class="e-pay-qr"/);
  for (const [, , attrs] of cells) assert.match(attrs, /valign="middle"/);
  assert.match(cells[0][2], /width="180"/);
  assert.match(cells[0][2], /padding:0 28px 0 0/, 'mezera mezi QR a údaji');
  assert.ok(section.indexOf(`cid:${QR_CONTENT_ID}`) < section.indexOf('Číslo účtu'));
  assert.doesNotMatch(section, /display:(flex|grid)/);
  // Mobil: v media query se obě buňky přepnou na bloky přes celou šířku, QR na střed.
  const mobile = /@media only screen and \(max-width:620px\)\{(.*?)\}@media/.exec(email.html)![1];
  assert.match(mobile, /\.e-pay-qr,\.e-pay-details\{display:block!important;width:100%!important;padding:0!important\}/);
  assert.match(mobile, /\.e-pay-qr\{text-align:center!important;padding-bottom:20px!important\}/);
  // IBAN a číslo účtu: žádné nowrap, zalomení po skupinách (<wbr>) a nouzově kdekoli.
  const value = (label: string) => new RegExp(`>${label}</td><td ([^>]*)>(.*?)</td>`).exec(section)!;
  for (const label of ['IBAN', 'Číslo účtu']) {
    const [, attrs, content] = value(label);
    assert.doesNotMatch(attrs, /nowrap/, label);
    assert.match(attrs, /overflow-wrap:anywhere/, label);
    assert.ok(content.includes('<wbr>'), label);
  }
  assert.equal(value('IBAN')[2], 'CZ19<wbr>9999<wbr>0000<wbr>0012<wbr>3456<wbr>7890');
  assert.doesNotMatch(email.html, /e-nowrap/);
});

test('patička: položky oddělené jen odsazením buněk – žádný oddělovací znak ani &nbsp;; odkazy beze změny', () => {
  for (const locale of LOCALES) {
    const email = renderConfirmationEmail(SAMPLE, locale);
    const footer = email.html.slice(email.html.indexOf('class="e-foot'));
    assert.doesNotMatch(visibleText(footer), /[·•|/]/, locale);
    assert.ok(!footer.includes('&nbsp;'), locale);
    const items = [...footer.matchAll(/<td class="e-item"[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    assert.deepEqual(items, [
      `<a href="${BUSINESS.BUSINESS_WEBSITE_URL}" style="color:#5c6a63;text-decoration:underline;">${BUSINESS.BUSINESS_NAME}</a>`,
      `<a href="mailto:${BUSINESS.BUSINESS_EMAIL_INFO}" style="color:#5c6a63;text-decoration:underline;">${BUSINESS.BUSINESS_EMAIL_INFO}</a>`,
      `IČ: ${BUSINESS.BUSINESS_ICO}`,
    ]);
    // Plaintext patička: položky na samostatných řádcích, bez oddělovačů.
    assert.ok(email.text.endsWith(`--\n${BUSINESS.BUSINESS_NAME}\n${BUSINESS.BUSINESS_EMAIL_INFO}\nIČ: ${BUSINESS.BUSINESS_ICO}`), locale);
  }
});

test('hlavička a značka se úpravou těla nezměnily (otisk HTML hlavičky a PNG domku)', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
  const expected = { cs: '2e1d0c773f5f50d7', en: '009b66832943d3b7', de: '938eae218297c652', ua: '8df54c3a17d5b036' };
  for (const locale of LOCALES) {
    const email = renderConfirmationEmail(SAMPLE, locale);
    assert.equal(sha(email.html.slice(email.html.indexOf('<tr><td class="e-header'), email.html.indexOf('<h1'))), expected[locale], locale);
    assert.equal(sha(email.attachments.find((a) => a.contentId === BRAND_MARK_CONTENT_ID)!.content), '286c1b7ac1876964');
  }
});
