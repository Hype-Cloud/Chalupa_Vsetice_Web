import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ICAL from 'ical.js';
import { zonedDateTime } from '../lib/availability/dates.ts';
import { STAY_TIMES } from '../lib/booking/rules.ts';
import { LOCALES, createI18n } from '../lib/i18n/index.ts';
import { parseConfirmation } from '../components/booking/reservation.ts';
import { buildStayCalendar, calendarOrigin, calendarUrl, CALENDAR_TOKEN, handleCalendar, newCalendarToken } from '../worker/booking/calendar.ts';
import { renderConfirmationEmail } from '../worker/booking/confirmation.ts';
import { handleCreateReservation, type BookingDeps, type BookingEnv } from '../worker/booking/handler.ts';
import type { ReservationResponse } from '../worker/booking/response.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { RESEND_ENDPOINT } from '../worker/email/resend.ts';
import worker from '../worker/index.ts';
import { createTestDatabase } from './d1.ts';
import { FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN, fixture } from './helpers.ts';

// Odkaz „přidat do kalendáře“ (issue #38): neveřejný token, stejná calendarUrl v API i e-mailu,
// dynamický ICS. Jen smyšlené údaje: rok 2030, domény .invalid, fiktivní účet banky 9999.
const NOW = new Date('2030-01-10T10:00:00Z');
const GUEST = { firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'host-kalendar@example.invalid' };
const NOTE = 'Přijedeme pozdě večer.';
const stay = (extra: Record<string, unknown> = {}) => ({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, ...GUEST, note: NOTE, locale: 'cs', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', ...extra });
const TOKEN_URL = /^https:\/\/[^/]+\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;

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

function setup(options: { db?: 'preview' | 'production'; origin?: string } = {}) {
  const t = options.db === 'production' ? production : preview;
  const logs: string[] = [];
  const mails: { headers: Headers; body: { html: string; text: string; attachments?: { filename: string; content_id?: string }[] } }[] = [];
  let uuid = 0;
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: options.db ?? 'preview', BOOKING_API_ENABLED: 'true',
    PAYMENT_IBAN: FAKE_PAYMENT_IBAN, TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
    RESEND_API_KEY: 're_test_FAKE', BOOKING_CONFIRMATION_TEST_EMAIL: 'preview-schranka@example.invalid',
  };
  const deps: BookingDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SITEVERIFY_URL) return Response.json({ success: true });
      if (url === RESEND_ENDPOINT) {
        mails.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return Response.json({ id: 'fake' });
      }
      return new Response(fixture('01-single-and-multi.ics'));
    }) as typeof fetch,
    now: () => NOW,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    log: (message) => logs.push(message),
  };
  const post = async (body: unknown, key?: string) => {
    const response = await handleCreateReservation(
      new Request(`${options.origin ?? 'https://preview.test.invalid'}/api/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
    return { status: response.status, body: (await response.json()) as ReservationResponse & { replayed?: boolean } };
  };
  const calendar = (path: string, method = 'GET', db: D1Database | null = t.db) =>
    handleCalendar(new Request(`https://preview.test.invalid${path}`, { method }), { DB: db ?? undefined }, { now: () => NOW, log: (message) => logs.push(message) });
  return { t, logs, mails, post, calendar };
}

const pathOf = (url: string) => new URL(url).pathname;

test('nová rezervace: unikátní neveřejný token (43 znaků base64url), oddělený od interního id, kódu i VS', async () => {
  const s = setup();
  const a = await s.post(stay());
  const b = await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-04' }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const rows = (await s.t.db.prepare('SELECT id, public_code, variable_symbol, calendar_token FROM reservations ORDER BY public_code').all<Record<string, string>>()).results;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.calendar_token, CALENDAR_TOKEN);
    for (const other of [row.id, row.public_code, row.variable_symbol]) assert.ok(!row.calendar_token.includes(other) && !other.includes(row.calendar_token));
  }
  assert.notEqual(rows[0].calendar_token, rows[1].calendar_token);
  // Dvě rezervace → dvě různé URL; URL obsahuje přesně uložený token.
  assert.notEqual(a.body.reservation.calendarUrl, b.body.reservation.calendarUrl);
  assert.equal(TOKEN_URL.exec(a.body.reservation.calendarUrl!)![1], rows.find((r) => r.public_code === a.body.reservation.reservationCode)!.calendar_token);
  // Generátor: CSPRNG, různé hodnoty, správný tvar.
  const tokens = new Set(Array.from({ length: 200 }, newCalendarToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.match(token, CALENDAR_TOKEN);
});

test('replay (stejný Idempotency-Key i souběžný dvojklik) vrací stejnou calendarUrl; token se nemění', async () => {
  const s = setup();
  const first = await s.post(stay(), 'kalendar-000000000000001');
  const replay = await s.post(stay(), 'kalendar-000000000000001');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.reservation.calendarUrl, first.body.reservation.calendarUrl);
  const pair = await Promise.all([s.post(stay({ arrival: '2030-04-01', departure: '2030-04-03' }), 'kalendar-000000000000002'), s.post(stay({ arrival: '2030-04-01', departure: '2030-04-03' }), 'kalendar-000000000000002')]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 201]);
  assert.equal(pair[0].body.reservation.calendarUrl, pair[1].body.reservation.calendarUrl);
  assert.equal(await s.t.count('reservations'), 2);
});

test('legacy rezervace bez tokenu (NULL): replay funguje, calendarUrl null, e-mail i web bez odkazu', async () => {
  const s = setup();
  await s.post(stay(), 'kalendar-legacy-0000000001');
  await s.t.db.prepare('UPDATE reservations SET calendar_token = NULL').run();
  const replay = await s.post(stay(), 'kalendar-legacy-0000000001');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reservation.calendarUrl, null);
  const email = renderConfirmationEmail(replay.body, 'cs');
  assert.ok(!email.html.includes('/calendar/') && !email.text.includes('/calendar/'));
  assert.ok(!email.html.includes(createI18n('cs').t('email.calendarHint')));
  assert.equal(parseConfirmation(replay.body)!.calendarUrl, null);
  // Víc rezervací s NULL tokenem je v pořádku (UNIQUE jen pro vyplněné).
  await s.post(stay({ arrival: '2030-05-01', departure: '2030-05-03' }));
  await s.t.db.prepare('UPDATE reservations SET calendar_token = NULL').run();
  assert.equal(await s.t.count('reservations'), 2);
});

test('origin: produkce vždy https://chalupavsetice.cz (i z workers.dev), Preview origin požadavku', async () => {
  const prod = setup({ db: 'production', origin: 'https://chalupa-vsetice-web.example.workers.dev' });
  const created = await prod.post(stay());
  assert.equal(created.status, 201);
  assert.match(created.body.reservation.calendarUrl!, /^https:\/\/chalupavsetice\.cz\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
  const mail = prod.mails[0].body;
  assert.ok(!mail.html.includes('workers.dev') && !mail.text.includes('workers.dev'));
  assert.equal(calendarOrigin('production', 'https://x.workers.dev/api/reservations'), 'https://chalupavsetice.cz');
  assert.equal(calendarOrigin('preview', 'https://abc-chalupa.example.workers.dev/api/reservations'), 'https://abc-chalupa.example.workers.dev');
  assert.equal(calendarUrl('https://chalupavsetice.cz', null), null);
  assert.equal(calendarUrl('https://chalupavsetice.cz', 'kratky'), null);
});

test('ICS endpoint: platný token pending i paid → událost se správnými hlavičkami; HEAD bez těla', async () => {
  const s = setup();
  const { body } = await s.post(stay());
  const path = pathOf(body.reservation.calendarUrl!);
  for (const status of ['pending_payment', 'paid']) {
    await s.t.db.prepare('UPDATE reservations SET status = ?1').bind(status).run();
    const response = await s.calendar(path);
    assert.equal(response.status, 200, status);
    assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('content-disposition'), 'inline; filename="pobyt.ics"');
    assert.match(await response.text(), /^BEGIN:VCALENDAR\r\n/);
  }
  const head = await s.calendar(path, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await s.calendar(path, 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('ICS endpoint: neplatný formát (bez dotazu do D1), neexistující i zrušená rezervace → 404 noindex, no-store', async () => {
  const s = setup();
  const { body } = await s.post(stay());
  const path = pathOf(body.reservation.calendarUrl!);
  // Neplatný formát se odmítne před databází: D1, která při dotazu vyhodí chybu, se nepoužije.
  const exploding = { prepare: () => { throw new Error('DB se nemá volat'); } } as unknown as D1Database;
  for (const bad of ['/calendar/abc.ics', '/calendar/' + 'A'.repeat(42) + '.ics', '/calendar/' + 'A'.repeat(44) + '.ics', '/calendar/' + 'A'.repeat(42) + '!.ics', '/calendar/' + 'A'.repeat(43), '/calendar/' + 'A'.repeat(43) + '.ics/x', '/calendar/10013001.ics', '/calendar/00000000-0000-4000-8000-000000000001.ics']) {
    const response = await s.calendar(bad, 'GET', exploding);
    assert.equal(response.status, 404, bad);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal((await s.calendar('/calendar/' + 'B'.repeat(43) + '.ics')).status, 404, 'neexistující token');
  await s.t.db.prepare(`UPDATE reservations SET status = 'cancelled'`).run();
  const cancelled = await s.calendar(path);
  assert.equal(cancelled.status, 404, 'zrušená rezervace = stejně jako neexistující odkaz');
  assert.ok(!(await cancelled.text()).includes('BEGIN:VCALENDAR'));
  // Bez D1 → 503; token ani URL se nelogují.
  assert.equal((await s.calendar(path, 'GET', null)).status, 503);
  const token = TOKEN_URL.exec(body.reservation.calendarUrl!)![1];
  assert.ok(!s.logs.join('\n').includes(token) && !s.logs.join('\n').includes('/calendar/'));
});

test('ICS: validní VCALENDAR/VEVENT (ical.js), CRLF, METHOD:PUBLISH, stabilní UID, příjezd 14:00 a odjezd 11:00 Europe/Prague', async () => {
  const s = setup();
  const { body } = await s.post(stay());
  const path = pathOf(body.reservation.calendarUrl!);
  const text = await (await s.calendar(path)).text();
  // Jen CRLF, žádné samotné LF; řádky nejvýš 75 oktetů.
  assert.ok(text.endsWith('\r\n'));
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\r\n]/);
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  for (const line of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'END:VEVENT', 'END:VCALENDAR']) assert.ok(text.includes(`${line}\r\n`), line);
  assert.equal(text.match(/BEGIN:VEVENT/g)!.length, 1);
  const calendar = new ICAL.Component(ICAL.parse(text));
  const event = new ICAL.Event(calendar.getFirstSubcomponent('vevent')!);
  // 1. 2. 2030 14:00 SEČ = 13:00Z; 4. 2. 2030 11:00 SEČ = 10:00Z.
  assert.equal(event.startDate.toJSDate().toISOString(), '2030-02-01T13:00:00.000Z');
  assert.equal(event.endDate.toJSDate().toISOString(), '2030-02-04T10:00:00.000Z');
  assert.equal(event.summary, 'Pobyt – Chalupa Všetice');
  assert.equal(event.description, `Příjezd od ${STAY_TIMES.checkIn}, odjezd do ${STAY_TIMES.checkOut}.`);
  // Stabilní UID (stejné při každém stažení), bez tokenu i interního id.
  const again = await (await s.calendar(path)).text();
  const uid = (value: string) => /^UID:(.+)$/m.exec(value)![1].trim();
  assert.equal(uid(text), uid(again));
  assert.match(uid(text), /^pobyt-[0-9a-f]{32}@chalupavsetice\.cz$/);
});

test('ICS: zimní, letní termín a pobyty přes přechod času (Europe/Prague)', async () => {
  const cases = [
    ['2030-01-10', '2030-01-12', '2030-01-10T13:00:00.000Z', '2030-01-12T10:00:00.000Z'], // zima (UTC+1)
    ['2030-07-10', '2030-07-12', '2030-07-10T12:00:00.000Z', '2030-07-12T09:00:00.000Z'], // léto (UTC+2)
    ['2030-03-30', '2030-04-01', '2030-03-30T13:00:00.000Z', '2030-04-01T09:00:00.000Z'], // přes začátek letního času 31. 3. 2030
    ['2030-10-26', '2030-10-28', '2030-10-26T12:00:00.000Z', '2030-10-28T10:00:00.000Z'], // přes konec letního času 27. 10. 2030
  ];
  for (const [arrival, departure, start, end] of cases) {
    const text = await buildStayCalendar({ arrival, departure, locale: 'cs' }, newCalendarToken(), NOW);
    const event = new ICAL.Event(new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent('vevent')!);
    assert.equal(event.startDate.toJSDate().toISOString(), start, arrival);
    assert.equal(event.endDate.toJSDate().toISOString(), end, departure);
    assert.equal(zonedDateTime(arrival, STAY_TIMES.checkIn).toISOString(), start);
  }
  // Událost v jazyce rezervace; neznámý jazyk → čeština.
  for (const locale of LOCALES) {
    const text = await buildStayCalendar({ arrival: '2030-02-01', departure: '2030-02-04', locale }, newCalendarToken(), NOW);
    assert.ok(text.includes(createI18n(locale).t('calendarEvent.summary', { name: 'Chalupa Všetice' }).slice(0, 8)), locale);
  }
  assert.ok((await buildStayCalendar({ arrival: '2030-02-01', departure: '2030-02-04', locale: null }, newCalendarToken(), NOW)).includes('SUMMARY:Pobyt'));
});

test('ICS bez osobních, bankovních a interních údajů (jméno, e-mail, telefon, poznámka, cena, účet, IBAN, SPAYD, VS, kód, interní id, token)', async () => {
  const s = setup();
  const { body } = await s.post(stay());
  const token = TOKEN_URL.exec(body.reservation.calendarUrl!)![1];
  const id = (await s.t.db.prepare('SELECT id FROM reservations').first<{ id: string }>())!.id;
  const text = await (await s.calendar(pathOf(body.reservation.calendarUrl!))).text();
  const unfolded = text.replace(/\r\n[ \t]/g, '');
  for (const forbidden of ['Jan', 'Testovací', GUEST.email, '000 000', NOTE, 'pozdě', '8970', '8 970', 'Kč', FAKE_PAYMENT_IBAN, FAKE_ACCOUNT_NUMBER, 'SPD*', body.reservation.reservationCode, id, token, '00000000-0000-4000-8000']) {
    assert.ok(!unfolded.includes(forbidden), forbidden);
  }
});

test('e-mail: termín v hlavičce a řádek Termín používají stejnou calendarUrl; splatnost bez odkazu; věta ve 4 jazycích; žádná .ics příloha', async () => {
  const s = setup();
  const { body } = await s.post(stay());
  const url = body.reservation.calendarUrl!;
  const sent = s.mails[0].body;
  assert.deepEqual((sent.attachments ?? []).map((a) => a.filename).filter((name) => /\.ics$/i.test(name)), []);
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    const email = renderConfirmationEmail(body, locale);
    const calendarLinks = [...email.html.matchAll(/<a [^>]*href="([^"]*\/calendar\/[^"]*)"[^>]*>([^<]*)<\/a>/g)];
    assert.deepEqual(calendarLinks.map((m) => m[1]), [url, url], locale);
    const stay = i18n.formatDateRange(body.reservation.arrival, body.reservation.departure);
    const row = `${i18n.formatDate(body.reservation.arrival)} – ${i18n.formatDate(body.reservation.departure)}`;
    assert.deepEqual(calendarLinks.map((m) => m[2]), [stay, row].map((v) => v.replace(/&/g, '&amp;')), locale);
    // Splatnost (souhrn i úvod) není odkaz.
    const due = i18n.formatDeadlineDate(body.reservation.paymentDueAt);
    assert.doesNotMatch(email.html, new RegExp(`<a [^>]*>[^<]*${due.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), locale);
    assert.ok(email.html.includes(i18n.t('email.calendarHint')) && email.text.includes(i18n.t('email.calendarHint')), locale);
    assert.ok(email.text.includes(url), `${locale}: URL v plaintextu`);
    assert.ok(!email.attachments.some((a) => /\.ics$/i.test(a.filename)), locale);
  }
});

test('web success summary: calendarUrl jen ze serveru; frontend URL neskládá z kódu rezervace', () => {
  const base = (calendar: unknown) => ({
    reservation: { reservationCode: '10013001', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, totalCzk: 8970, status: 'pending_payment', paymentDueAt: '2030-01-11T22:59:59.000Z', calendarUrl: calendar },
    payment: { amountCzk: 8970, currency: 'CZK', accountNumber: FAKE_ACCOUNT_NUMBER, iban: FAKE_PAYMENT_IBAN, variableSymbol: '10013001', message: 'Rezervace 10013001', dueAt: '2030-01-11T22:59:59.000Z', spayd: 'SPD*1.0' },
  });
  const url = `https://chalupavsetice.cz/calendar/${'a'.repeat(43)}.ics`;
  assert.equal(parseConfirmation(base(url))!.calendarUrl, url);
  // Chybějící, null nebo neočekávaný tvar → termín bez odkazu (potvrzení se jinak přijme).
  for (const bad of [undefined, null, '', 'javascript:alert(1)', 'https://x.invalid/calendar/10013001.ics', `ftp://x.invalid/calendar/${'a'.repeat(43)}.ics`, `${url}?x=1`, 42]) {
    const parsed = parseConfirmation(base(bad));
    assert.ok(parsed, String(bad));
    assert.equal(parsed.calendarUrl, null, String(bad));
  }
  const component = readFileSync(new URL('../components/booking/BookingForm.tsx', import.meta.url), 'utf8');
  assert.match(component, /href=\{reservation\.calendarUrl\}/);
  assert.doesNotMatch(component, /\/calendar\//);
  // Splatnost zůstává prostý text.
  assert.match(component, /<dd>\{formatDeadlineDate\(reservation\.paymentDueAt\)\}<\/dd>/);
});

test('Worker obsluhuje /calendar/* (run_worker_first), ne statické assety; žádná externí calendar služba', async () => {
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"run_worker_first":\s*\["\/api\/\*",\s*"\/calendar\/\*"\]/);
  const assets = { fetch: async () => new Response('asset') } as unknown as Fetcher;
  const response = await worker.fetch(new Request(`https://chalupavsetice.cz/calendar/${'C'.repeat(43)}.ics`) as never, { ASSETS: assets } as never, { waitUntil: () => undefined } as unknown as ExecutionContext);
  assert.equal(response.status, 503, 'Worker (bez D1) – ne asset');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  for (const file of ['worker/booking/calendar.ts', 'worker/booking/confirmation.ts', 'components/booking/BookingForm.tsx', 'components/booking/reservation.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /google\.com\/calendar|calendar\.google|outlook\.(live|office)|addtocalendar|add-to-calendar|webcal:/i, file);
  }
});

test('migrace 0010: token jen ve správném tvaru, UNIQUE; starší zápis bez tokenu (NULL) projde', async () => {
  const s = setup();
  await s.post(stay());
  const insert = (id: string, token: string | null, code: string) =>
    s.t.db.prepare(`INSERT INTO reservations (id, public_code, arrival, departure, guests, first_name, last_name, phone, email, price_czk, variable_symbol, ical_uid, created_at, updated_at, calendar_token)
      VALUES (?1, ?3, '2030-06-01', '2030-06-03', 2, 'A', 'B', '+420000000000', 'a@example.invalid', 5980, ?3, ?1, '2030-01-10T10:00:00Z', '2030-01-10T10:00:00Z', ?2)`).bind(id, token, code).run();
  await assert.rejects(insert('x1', 'kratky', 'L1'), /CHECK constraint failed/);
  await assert.rejects(insert('x2', `${'A'.repeat(42)}!`, 'L2'), /CHECK constraint failed/);
  const existing = (await s.t.db.prepare('SELECT calendar_token FROM reservations').first<{ calendar_token: string }>())!.calendar_token;
  await assert.rejects(insert('x3', existing, 'L3'), /UNIQUE constraint failed: reservations\.calendar_token/);
  await insert('x4', null, 'L4');
  await insert('x5', null, 'L5');
});
