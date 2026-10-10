import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledConflictCheck, type CronEnv } from '../worker/booking/cron.ts';
import { RESEND_ENDPOINT } from '../worker/booking/alerts.ts';
import { insertReservation, type NewReservation } from '../worker/booking/db.ts';
import { pendingConflictNotifications, runConflictReconciliation } from '../worker/booking/conflicts.ts';
import { getAvailability, resetAvailabilityMemory } from '../worker/availability.ts';
import { icalUidFor } from '../lib/booking/codes.ts';
import { createTestDatabase } from './d1.ts';

// Jen smyšlené údaje; žádné volání skutečného e-mailového providera ani e-chalup.
const EXPORT_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const API_KEY = 're_test_SECRET_KEY_456';
const ADMIN = 'spravce@example.invalid';
const NOW = new Date('2030-01-10T10:00:00.000Z');

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(async () => {
  await t.db.prepare('DELETE FROM reservation_conflicts').run();
  await t.reset();
});

let counter = 0;
async function reserve(arrival: string, departure: string): Promise<NewReservation & { publicCode: string }> {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const r: NewReservation = {
    id, icalUid: icalUidFor(id), arrival, departure, guests: 2,
    firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'host@example.invalid', priceCzk: 3000,
    idempotencyKey: null, requestHash: null, createdAt: '2030-01-10T09:00:00.000Z',
  };
  return { ...r, publicCode: (await insertReservation(t.db, r)).code };
}

const ICS = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//CS\r\n${events}END:VCALENDAR\r\n`;
const VEVENT = (uid: string, start: string, end: string) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}\r\nSUMMARY:Cizí host Novák\r\nEND:VEVENT\r\n`;
const BROKEN = 'BEGIN:VEVENT\r\nUID:vadna@test.invalid\r\nSUMMARY:bez data\r\nEND:VEVENT\r\n';

interface Mail { headers: Headers; body: { from: string; to: string[]; subject: string; text: string } }

/** Falešný fetch: export e-chalup a Resend API. */
function setup(options: { exportBody?: () => string | null; mailStatus?: () => number; env?: Partial<CronEnv> } = {}) {
  const mails: Mail[] = [];
  const logs: string[] = [];
  let exportBody = options.exportBody ?? (() => ICS(''));
  let mailStatus = options.mailStatus ?? (() => 200);
  let minutes = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RESEND_ENDPOINT) {
      mails.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response('{"id":"x"}', { status: mailStatus() });
    }
    if (url === EXPORT_URL) {
      const body = exportBody();
      return body === null ? new Response('down', { status: 503 }) : new Response(body);
    }
    throw new Error(`neočekávaný požadavek ${url}`);
  }) as typeof fetch;
  const env: CronEnv = { DB: t.db, BOOKING_ENV: 'preview', ECHALUPY_ICAL_URL: EXPORT_URL, RESEND_API_KEY: API_KEY, CONFLICT_ALERT_EMAIL: ADMIN, ...options.env };
  return {
    env,
    mails,
    logs,
    fetchFn,
    setExport: (fn: () => string | null) => (exportBody = fn),
    setMailStatus: (fn: () => number) => (mailStatus = fn),
    run: () => runScheduledConflictCheck(env, { fetch: fetchFn, now: () => new Date(NOW.getTime() + 60_000 * (minutes += 10)), log: (m) => logs.push(m) }),
  };
}

const conflicts = async () =>
  (await t.db.prepare('SELECT conflict_start, conflict_end, resolved_at, notified_at FROM reservation_conflicts ORDER BY id').all<{ conflict_start: string; conflict_end: string; resolved_at: string | null; notified_at: string | null }>()).results;

test('A–C: Cron bez návštěvy webu najde kolizi, pošle e-mail a nastaví notified_at', async () => {
  const a = await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('airbnb-1@test.invalid', '20300303', '20300307')) });
  await s.run();
  assert.equal(s.mails.length, 1);
  const [mail] = s.mails;
  assert.equal(mail.body.subject, `[TEST] POZOR: kolize rezervace ${a.publicCode}`);
  assert.deepEqual(mail.body.to, [ADMIN]);
  assert.match(mail.body.text, /V externím kalendáři se objevil termín překrývající rezervaci z webu\./);
  assert.match(mail.body.text, /Zkontrolujte e-chalupy \/ Booking \/ Airbnb\./);
  assert.match(mail.body.text, /Kolidující termín: 3\. 3\. 2030 – 5\. 3\. 2030 \(2 noci\)/);
  assert.equal(mail.headers.get('authorization'), `Bearer ${API_KEY}`);
  assert.match(mail.headers.get('idempotency-key')!, /^conflict-alert-preview-\d+$/);
  const [row] = await conflicts();
  assert.notEqual(row.notified_at, null);
  assert.equal(row.resolved_at, null);
  assert.deepEqual(s.logs, ['conflicts-cron: 1 new, 1 active', 'conflicts-mail: 1 sent']);
});

test('D: další Cron při trvající kolizi druhý e-mail neodešle', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('airbnb-1@test.invalid', '20300303', '20300307')) });
  await s.run();
  await s.run();
  await s.run();
  assert.equal(s.mails.length, 1);
  assert.equal((await conflicts()).length, 1);
});

test('E: chyba providera → notified_at zůstane NULL a další běh e-mail zopakuje se stejným klíčem', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('airbnb-1@test.invalid', '20300303', '20300307')), mailStatus: () => 500 });
  await s.run();
  assert.equal((await conflicts())[0].notified_at, null);
  assert.ok(s.logs.includes('conflicts-mail: send failed (http-500)'));
  s.setMailStatus(() => 200);
  await s.run();
  assert.equal(s.mails.length, 2);
  assert.equal(s.mails[0].headers.get('idempotency-key'), s.mails[1].headers.get('idempotency-key'));
  assert.notEqual((await conflicts())[0].notified_at, null);
});

test('E2: chybějící konfigurace e-mailu → nic se neodešle, upozornění čeká', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307')), env: { RESEND_API_KEY: undefined } });
  await s.run();
  assert.equal(s.mails.length, 0);
  assert.equal((await pendingConflictNotifications(t.db)).length, 1);
  assert.ok(s.logs.includes('conflicts-mail: not configured (1 pending)'));
});

test('F: nesoulad prostředí D1 → nic se nestáhne, nezapíše ani neodešle', async () => {
  await reserve('2030-03-01', '2030-03-05');
  let fetched = 0;
  const s = setup({ exportBody: () => (fetched++, ICS(VEVENT('a@test.invalid', '20300303', '20300307'))), env: { BOOKING_ENV: 'production' } });
  await s.run();
  assert.equal(fetched, 0);
  assert.equal(s.mails.length, 0);
  assert.equal((await conflicts()).length, 0);
  assert.deepEqual(s.logs, ['conflicts-cron: database environment mismatch']);
  const noDb = setup({ env: { DB: undefined } });
  await noDb.run();
  assert.deepEqual(noDb.logs, ['conflicts-cron: not configured']);
});

test('G: výpadek e-chalup → kolize zůstane aktivní, čekající upozornění se přesto odešle', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307')), mailStatus: () => 500 });
  await s.run();
  s.setExport(() => null);
  s.setMailStatus(() => 200);
  await s.run();
  const [row] = await conflicts();
  assert.equal(row.resolved_at, null, 'výpadek nic neuzavírá');
  assert.notEqual(row.notified_at, null);
  assert.ok(s.logs.includes('conflicts-cron: upstream unavailable (http-503)'));
  // Neplatný iCal ani překročený limit nic neuzavřou.
  s.setExport(() => '<html>chyba</html>');
  await s.run();
  assert.equal((await conflicts())[0].resolved_at, null);
});

test('H: neúplný export → starou kolizi neuzavře', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307')) });
  await s.run();
  s.setExport(() => ICS(BROKEN));
  await s.run();
  assert.equal((await conflicts())[0].resolved_at, null);
  assert.ok(s.logs.includes('conflicts-cron: incomplete snapshot'));
});

test('I: kolize vyřešená před odesláním se už neposílá', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307')), mailStatus: () => 500 });
  await s.run();
  s.setExport(() => ICS(''));
  s.setMailStatus(() => 200);
  const before = s.mails.length;
  await s.run();
  assert.notEqual((await conflicts())[0].resolved_at, null);
  assert.equal(s.mails.length, before, 'vyřešená kolize se neposílá');
});

test('J: Cron a GET /api/availability blízko sebe → žádné duplicitní aktivní kolize', async () => {
  resetAvailabilityMemory();
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307')) });
  const pending: Promise<unknown>[] = [];
  const availability = getAvailability({ ECHALUPY_ICAL_URL: EXPORT_URL }, {
    fetch: s.fetchFn,
    now: () => NOW,
    cache: null,
    defer: (p) => pending.push(p),
    log: () => undefined,
    onFreshSnapshot: (snapshot, at) => runConflictReconciliation(s.env, snapshot, at, () => undefined),
  });
  await Promise.all([availability, s.run(), s.run()]);
  await Promise.all(pending);
  const rows = await conflicts();
  assert.equal(rows.filter((r) => r.resolved_at === null).length, 1);
  assert.ok(s.mails.length >= 1);
  const keys = new Set(s.mails.map((m) => m.headers.get('idempotency-key')));
  assert.equal(keys.size, 1, 'případné souběžné opakování nese stejný Idempotency-Key');
});

test('K: dvě čekající kolize → dva e-maily, každý se svým klíčem; selhání jednoho neblokuje druhý', async () => {
  const a = await reserve('2030-03-01', '2030-03-05');
  const b = await reserve('2030-04-01', '2030-04-05');
  let call = 0;
  const s = setup({
    exportBody: () => ICS(VEVENT('a@test.invalid', '20300303', '20300307') + VEVENT('b@test.invalid', '20300402', '20300403')),
    mailStatus: () => (++call === 1 ? 500 : 200),
  });
  await s.run();
  assert.equal(s.mails.length, 2);
  assert.equal((await pendingConflictNotifications(t.db)).length, 1, 'neodeslaná kolize čeká');
  await s.run();
  assert.equal((await pendingConflictNotifications(t.db)).length, 0);
  const subjects = s.mails.map((m) => m.body.subject);
  assert.ok(subjects.some((x) => x.includes(a.publicCode)) && subjects.some((x) => x.includes(b.publicCode)));
  assert.equal(new Set(s.mails.slice(-2).map((m) => m.headers.get('idempotency-key'))).size, 2);
});

test('L: e-mail ani logy neobsahují údaje hosta, cizí UID, texty událostí ani secrets', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const s = setup({ exportBody: () => ICS(VEVENT('airbnb-tajne-uid@test.invalid', '20300303', '20300307')), mailStatus: () => 500 });
  await s.run();
  s.setExport(() => null);
  s.setMailStatus(() => 200);
  await s.run();
  const everything = JSON.stringify(s.mails.map((m) => m.body)) + s.logs.join('\n');
  for (const secret of ['Jan', 'Testovací', '000 000', 'host@example.invalid', 'airbnb-tajne-uid', 'Novák', API_KEY, 'SECRET-TOKEN-123', 'ical.test.invalid']) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('produkční e-mail nemá označení TEST', async () => {
  const prod = await createTestDatabase('production');
  try {
    await insertReservation(prod.db, {
      id: 'p1', icalUid: icalUidFor('p1'), arrival: '2030-03-01', departure: '2030-03-02', guests: 1,
      firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'host@example.invalid', priceCzk: 3000,
      idempotencyKey: null, requestHash: null, createdAt: '2030-01-10T09:00:00.000Z',
    });
    const s = setup({ exportBody: () => ICS(VEVENT('a@test.invalid', '20300301', '20300302')), env: { DB: prod.db, BOOKING_ENV: 'production' } });
    await s.run();
    assert.equal(s.mails[0].body.subject, 'POZOR: kolize rezervace 10013001');
    assert.equal(s.mails[0].headers.get('idempotency-key')?.startsWith('conflict-alert-production-'), true);
  } finally {
    await prod.dispose();
  }
});
