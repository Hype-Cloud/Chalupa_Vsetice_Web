import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { businessIdentity } from '../lib/business.ts';
import { buildStayCalendar, buildStayInvite, handleCalendar, inviteContentType } from '../worker/booking/calendar.ts';
import { calendarInviteVariant, confirmationIdempotencyKey } from '../worker/booking/confirmation.ts';
import { handleCreateReservation, type BookingDeps, type BookingEnv } from '../worker/booking/handler.ts';
import type { ReservationResponse } from '../worker/booking/response.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { RESEND_ENDPOINT } from '../worker/email/resend.ts';
import { createTestDatabase } from './d1.ts';
import { FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN, fixture } from './helpers.ts';

// Preview PoC kalendářové části v potvrzovacím e-mailu (CALENDAR_INVITE_POC=publish|request).
// Jen smyšlené údaje: rok 2030, domény .invalid, fiktivní účet banky 9999.
const NOW = new Date('2030-01-10T10:00:00Z');
const TEST_INBOX = 'preview-schranka@example.invalid';
const GUEST = { firstName: 'Jan', lastName: 'Pozvánkový', phone: '+420 000 000 001', email: 'host-pozvanka@example.invalid' };
const NOTE = 'Poznámka jen pro provozovatele.';
const stay = (extra: Record<string, unknown> = {}) => ({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, ...GUEST, note: NOTE, locale: 'cs', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', ...extra });

interface SentMail {
  headers: Headers;
  body: { from: string; to: string[]; attachments?: { filename: string; content: string; content_type?: string; content_id?: string }[] };
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

function setup(options: { env?: 'preview' | 'production'; poc?: string } = {}) {
  const t = options.env === 'production' ? production : preview;
  const logs: string[] = [];
  const mails: SentMail[] = [];
  let uuid = 0;
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: options.env ?? 'preview', BOOKING_API_ENABLED: 'true',
    PAYMENT_IBAN: FAKE_PAYMENT_IBAN, TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
    RESEND_API_KEY: 're_test_FAKE', BOOKING_CONFIRMATION_TEST_EMAIL: TEST_INBOX,
    ...(options.poc !== undefined ? { CALENDAR_INVITE_POC: options.poc } : {}),
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
      new Request('https://preview.test.invalid/api/reservations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
    return { status: response.status, body: (await response.json()) as ReservationResponse };
  };
  const linkIcs = async (calendarUrl: string) =>
    (await handleCalendar(new Request(`https://preview.test.invalid${new URL(calendarUrl).pathname}`), { DB: t.db }, { now: () => NOW, log: () => undefined })).text();
  return { t, env, logs, mails, post, linkIcs };
}

const calendarParts = (mail: SentMail) => (mail.body.attachments ?? []).filter((a) => /\.ics$/i.test(a.filename) || /calendar/i.test(a.content_type ?? ''));
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const prop = (ics: string, name: string) => ics.split('\r\n').filter((line) => line.startsWith(`${name}:`) || line.startsWith(`${name};`));
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

/** Strukturální kontrola kalendářové části: parser, CRLF, 75 oktetů, method v MIME = METHOD v ICS. */
function assertCalendarPart(part: { filename: string; content: string; content_type?: string; content_id?: string }, method: 'PUBLISH' | 'REQUEST'): string {
  assert.equal(part.filename, 'pobyt.ics');
  assert.equal(part.content_type, `text/calendar; charset=utf-8; method=${method}`);
  assert.equal(part.content_id, undefined, 'kalendářová část není inline obrázek');
  const ics = decode(part.content);
  assert.ok(ics.endsWith('\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const calendar = new ICAL.Component(ICAL.parse(ics));
  assert.equal(calendar.getFirstPropertyValue('method'), method);
  assert.equal(/method=([A-Z]+)/.exec(part.content_type!)![1], calendar.getFirstPropertyValue('method'));
  assert.equal(calendar.getAllSubcomponents('vevent').length, 1);
  return ics;
}

test('gate: produkce nikdy nepřikládá kalendářovou část (ani s CALENDAR_INVITE_POC); klíč idempotence beze změny', async () => {
  for (const poc of ['publish', 'request']) {
    assert.equal(calendarInviteVariant({ BOOKING_ENV: 'production', CALENDAR_INVITE_POC: poc }, { test: false }), null);
    assert.equal(calendarInviteVariant({ BOOKING_ENV: 'production', CALENDAR_INVITE_POC: poc }, { test: true }), null);
    // Preview, ale ne testovací příjemce → nic.
    assert.equal(calendarInviteVariant({ BOOKING_ENV: 'preview', CALENDAR_INVITE_POC: poc }, { test: false }), null);
  }
  const s = setup({ env: 'production', poc: 'request' });
  const { status } = await s.post(stay());
  assert.equal(status, 201);
  assert.equal(s.mails.length, 1);
  assert.deepEqual(s.mails[0].body.to, [GUEST.email]);
  assert.deepEqual(calendarParts(s.mails[0]), []);
  assert.ok(s.mails[0].body.attachments!.every((a) => a.content_type === undefined));
  assert.equal(s.mails[0].headers.get('idempotency-key'), 'reservation-confirmation-production-00000000-0000-4000-8000-000000000001');
});

test('gate: Preview bez proměnné nebo s neplatnou hodnotou → potvrzení beze změny (bez kalendářové části)', async () => {
  for (const poc of [undefined, '', 'PUBLISH', 'cancel', 'request ; x']) {
    await preview.reset();
    const s = setup({ poc });
    await s.post(stay());
    assert.equal(s.mails.length, 1, String(poc));
    assert.deepEqual(calendarParts(s.mails[0]), [], String(poc));
    assert.equal(s.mails[0].headers.get('idempotency-key'), 'reservation-confirmation-preview-00000000-0000-4000-8000-000000000001');
  }
});

test('PUBLISH: jednorázová událost bez ATTENDEE i ORGANIZER; UID, časy a obsah shodné s odkazem; TENTATIVE, SEQUENCE:0', async () => {
  const s = setup({ poc: 'publish' });
  const { body } = await s.post(stay());
  assert.equal(s.mails.length, 1);
  assert.deepEqual(s.mails[0].body.to, [TEST_INBOX]);
  const parts = calendarParts(s.mails[0]);
  assert.equal(parts.length, 1);
  const ics = assertCalendarPart(parts[0], 'PUBLISH');
  assert.deepEqual(prop(ics, 'ATTENDEE'), []);
  assert.deepEqual(prop(ics, 'ORGANIZER'), []);
  assert.deepEqual(prop(ics, 'STATUS'), ['STATUS:TENTATIVE']);
  assert.deepEqual(prop(ics, 'SEQUENCE'), ['SEQUENCE:0']);
  assert.deepEqual(prop(ics, 'DTSTAMP'), ['DTSTAMP:20300110T100000Z']);
  const link = await s.linkIcs(body.reservation.calendarUrl!);
  for (const name of ['UID', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'URL']) assert.deepEqual(prop(ics, name), prop(link, name), name);
  // 1. 2. 2030 14:00 SEČ = 13:00Z; 4. 2. 2030 11:00 SEČ = 10:00Z.
  const event = new ICAL.Event(new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!);
  assert.equal(event.startDate.toJSDate().toISOString(), '2030-02-01T13:00:00.000Z');
  assert.equal(event.endDate.toJSDate().toISOString(), '2030-02-04T10:00:00.000Z');
  // Ostatní přílohy (inline obrázky) zůstávají; klíč idempotence nese variantu.
  assert.ok(s.mails[0].body.attachments!.some((a) => a.content_id === 'znacka'));
  assert.equal(s.mails[0].headers.get('idempotency-key'), 'reservation-confirmation-preview-00000000-0000-4000-8000-000000000001-calendar-publish');
  assert.ok(s.logs.includes('reservations: confirmation email sent (calendar publish)'));
});

test('REQUEST: ORGANIZER = odesílatel, jediný ATTENDEE = testovací schránka (RSVP=FALSE), nikdy e-mail hosta; poznámka o odpovědi', async () => {
  const s = setup({ poc: 'request' });
  await s.post(stay());
  const parts = calendarParts(s.mails[0]);
  assert.equal(parts.length, 1);
  const ics = unfold(assertCalendarPart(parts[0], 'REQUEST'));
  const business = businessIdentity();
  assert.ok(s.mails[0].body.from.endsWith(`<${business.emailReservations}>`));
  assert.deepEqual(prop(ics, 'ORGANIZER'), [`ORGANIZER;CN="${business.name}":mailto:${business.emailReservations}`]);
  assert.deepEqual(prop(ics, 'ATTENDEE'), [`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${TEST_INBOX}`]);
  assert.ok(!ics.includes(GUEST.email));
  assert.deepEqual(prop(ics, 'STATUS'), ['STATUS:TENTATIVE']);
  const event = new ICAL.Event(new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!);
  assert.equal(event.description, 'Příjezd od 14:00, odjezd do 11:00. Odpověď na tuto pozvánku rezervaci nemění.');
  assert.equal(s.mails[0].headers.get('idempotency-key'), 'reservation-confirmation-preview-00000000-0000-4000-8000-000000000001-calendar-request');
});

test('bez osobních, bankovních a interních údajů v obou variantách (kromě ATTENDEE testovací schránky u REQUEST)', async () => {
  for (const poc of ['publish', 'request']) {
    await preview.reset();
    const s = setup({ poc });
    const { body } = await s.post(stay());
    const ics = unfold(decode(calendarParts(s.mails[0])[0].content));
    const token = /\/calendar\/([A-Za-z0-9_-]{43})\.ics$/.exec(body.reservation.calendarUrl!)![1];
    const forbidden = [GUEST.firstName, GUEST.lastName, GUEST.phone, GUEST.email, NOTE, FAKE_PAYMENT_IBAN, FAKE_ACCOUNT_NUMBER, body.reservation.reservationCode, String(body.reservation.totalCzk), '00000000-0000-4000-8000-000000000001', token, 'SPD*'];
    for (const value of forbidden) assert.ok(!ics.includes(value), `${poc}: ${value}`);
  }
});

test('replay se stejným Idempotency-Key: stejný klíč u Resend a bajtově stejné ICS (DTSTAMP z created_at)', async () => {
  const s = setup({ poc: 'request' });
  await s.post(stay(), 'pozvanka-replay-00000001');
  const later = setup({ poc: 'request' });
  const replay = await later.post(stay(), 'pozvanka-replay-00000001');
  assert.equal(replay.status, 200);
  assert.equal(later.mails.length, 1);
  assert.equal(later.mails[0].headers.get('idempotency-key'), s.mails[0].headers.get('idempotency-key'));
  assert.equal(calendarParts(later.mails[0])[0].content, calendarParts(s.mails[0])[0].content);
  // Jiná varianta pro stejnou rezervaci má jiný klíč (nekoliduje v 24h okně Resend).
  assert.notEqual(
    confirmationIdempotencyKey({ BOOKING_ENV: 'preview' }, 'x', 'publish'),
    confirmationIdempotencyKey({ BOOKING_ENV: 'preview' }, 'x', 'request'),
  );
  assert.equal(confirmationIdempotencyKey({ BOOKING_ENV: 'preview' }, 'x'), 'reservation-confirmation-preview-x');
});

test('legacy rezervace bez tokenu: potvrzení odejde bez kalendářové části a s původním klíčem', async () => {
  const s = setup({ poc: 'publish' });
  await s.post(stay(), 'pozvanka-legacy-00000001');
  await s.t.db.prepare('UPDATE reservations SET calendar_token = NULL').run();
  const later = setup({ poc: 'publish' });
  await later.post(stay(), 'pozvanka-legacy-00000001');
  assert.equal(later.mails.length, 1);
  assert.deepEqual(calendarParts(later.mails[0]), []);
  assert.equal(later.mails[0].headers.get('idempotency-key'), 'reservation-confirmation-preview-00000000-0000-4000-8000-000000000001');
  assert.ok(later.logs.includes('reservations: calendar invite skipped (publish)'));
});

test('buildStayInvite: paid → CONFIRMED, přechod času, neplatný ATTENDEE i token → chyba; odkaz (PUBLISH) beze změny', async () => {
  const token = 'A'.repeat(43);
  const summer = { arrival: '2030-03-30', departure: '2030-04-01', locale: 'cs' };
  const paid = await buildStayInvite(summer, token, { method: 'PUBLISH', status: 'paid', createdAt: '2030-01-10T10:00:00.000Z' });
  assert.deepEqual(prop(paid, 'STATUS'), ['STATUS:CONFIRMED']);
  // 30. 3. 2030 14:00 SEČ = 13:00Z; 1. 4. 2030 11:00 SELČ = 09:00Z.
  assert.deepEqual(prop(paid, 'DTSTART'), ['DTSTART:20300330T130000Z']);
  assert.deepEqual(prop(paid, 'DTEND'), ['DTEND:20300401T090000Z']);
  for (const attendee of [undefined, '', 'bez-zavinace', 'a@b.invalid;ROLE=CHAIR', 'a@b.invalid\r\nATTENDEE:x@y.invalid', '"x"@y.invalid', 'a b@c.invalid']) {
    await assert.rejects(buildStayInvite(summer, token, { method: 'REQUEST', status: 'pending_payment', createdAt: '2030-01-10T10:00:00Z', ...(attendee !== undefined ? { attendee } : {}) }), /invalid-invite/, String(attendee));
  }
  await assert.rejects(buildStayInvite(summer, 'kratky', { method: 'PUBLISH', status: 'paid', createdAt: '2030-01-10T10:00:00Z' }), /invalid-invite/);
  await assert.rejects(buildStayInvite(summer, token, { method: 'PUBLISH', status: 'paid', createdAt: 'nesmysl' }), /invalid-invite/);
  assert.equal(inviteContentType('REQUEST'), 'text/calendar; charset=utf-8; method=REQUEST');
  // Veřejný odkaz zůstává bez SEQUENCE/STATUS/ORGANIZER/ATTENDEE.
  const link = await buildStayCalendar(summer, token, NOW);
  for (const name of ['SEQUENCE', 'STATUS', 'ORGANIZER', 'ATTENDEE']) assert.deepEqual(prop(link, name), [], name);
});
