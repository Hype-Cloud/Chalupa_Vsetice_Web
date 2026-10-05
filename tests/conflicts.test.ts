import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cancelReservation, insertReservation, type NewReservation } from '../worker/booking/db.ts';
import { markConflictsNotified, pendingConflictNotifications, reconcileConflicts, runConflictReconciliation, type ExternalSnapshot } from '../worker/booking/conflicts.ts';
import { getAvailability, resetAvailabilityMemory, type AvailabilityDeps } from '../worker/availability.ts';
import { parseCalendarEvents, type CalendarEvent } from '../worker/ical.ts';
import { icalUidFor } from '../lib/booking/codes.ts';
import { createTestDatabase } from './d1.ts';

// Jen smyšlené rezervace (rok 2030, domény .invalid).
const RANGE = { from: '2030-01-09', to: '2031-02-14' };
const T1 = new Date('2030-01-10T10:00:00.000Z');
const T2 = new Date('2030-01-10T10:05:00.000Z');
const T3 = new Date('2030-01-10T10:10:00.000Z');

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(async () => {
  await t.db.prepare('DELETE FROM reservation_conflicts').run();
  await t.reset();
});

let counter = 0;
async function reserve(arrival: string, departure: string): Promise<NewReservation> {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const r: NewReservation = {
    id, publicCode: `CV-${String(counter).padStart(6, '0')}`, icalUid: icalUidFor(id), arrival, departure, guests: 2,
    firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid', priceCzk: 3000,
    idempotencyKey: null, requestHash: null, vsPrefix: '30', createdAt: '2030-01-10T09:00:00.000Z',
  };
  await insertReservation(t.db, r);
  return r;
}

const ev = (start: string, end: string, uid: string | null = 'airbnb-1@test.invalid', codes: string[] = []): CalendarEvent => ({ start, end, uid, codes });
const snap = (events: CalendarEvent[], complete = true): ExternalSnapshot => ({ events, range: RANGE, complete });

type Row = { reservation_id: string; conflict_start: string; conflict_end: string; detected_at: string; last_seen_at: string; resolved_at: string | null; notified_at: string | null };
const rows = async () => (await t.db.prepare('SELECT * FROM reservation_conflicts ORDER BY id').all<Row>()).results;
const active = async () => (await rows()).filter((r) => r.resolved_at === null);

test('webová rezervace první, cizí rezervace se objeví později → nová kolize', async () => {
  const a = await reserve('2030-03-01', '2030-03-05');
  assert.deepEqual((await reconcileConflicts(t.db, snap([]), T1)).newConflicts, []);
  const result = await reconcileConflicts(t.db, snap([ev('2030-03-03', '2030-03-07')]), T2);
  assert.deepEqual(result, { newConflicts: [{ reservationCode: a.publicCode, start: '2030-03-03', end: '2030-03-05' }], active: 1 });
  const [row] = await rows();
  assert.equal(row.reservation_id, a.id);
  assert.equal(row.detected_at, T2.toISOString());
  assert.equal(row.notified_at, null, 'upozornění čeká na odeslání');
});

test('ozvěna vlastní rezervace (stejné UID nebo kód) není kolize', async () => {
  const a = await reserve('2030-03-01', '2030-03-05');
  const echoes = [ev('2030-03-01', '2030-03-05', a.icalUid), ev('2030-03-01', '2030-03-05', 'echalupy-9@test.invalid', [a.publicCode])];
  assert.deepEqual(await reconcileConflicts(t.db, snap(echoes), T1), { newConflicts: [], active: 0 });
});

test('stejné UID jako vlastní rezervace, ale jiný termín: podle současných pravidel ozvěna, ne kolize', async () => {
  const a = await reserve('2030-03-01', '2030-03-05');
  // Např. správce rezervaci v e-chalupách posunul; cizí UID se stejným termínem kolizí je.
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-03-02', '2030-03-06', a.icalUid)]), T1)).active, 0);
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-03-01', '2030-03-05', 'booking-7@test.invalid')]), T2)).active, 1);
});

test('ozvěna jiné (i zrušené) vlastní rezervace se za cizí kolizi nepovažuje', async () => {
  const b = await reserve('2030-04-01', '2030-04-05');
  await cancelReservation(t.db, b.id, T1.toISOString());
  await reserve('2030-04-01', '2030-04-03');
  // E-chalupy ještě drží zrušenou B (zrušení se teprve importuje).
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-04-01', '2030-04-05', b.icalUid)]), T2)).active, 0);
});

test('hranice: navazující pobyty nejsou kolize, částečný překryv ano', async () => {
  await reserve('2030-05-10', '2030-05-15');
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-05-15', '2030-05-18', 'b-po@test.invalid')]), T1)).active, 0, 'B začíná v den odjezdu A');
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-05-07', '2030-05-10', 'b-pred@test.invalid')]), T1)).active, 0, 'B končí v den příjezdu A');
  const partial = await reconcileConflicts(t.db, snap([ev('2030-05-14', '2030-05-16', 'b-prekryv@test.invalid')]), T2);
  assert.deepEqual(partial.newConflicts.map((c) => [c.start, c.end]), [['2030-05-14', '2030-05-15']]);
});

test('více cizích událostí přes jednu rezervaci: deterministicky, idempotentně', async () => {
  await reserve('2030-06-01', '2030-06-10');
  const events = [ev('2030-06-08', '2030-06-12', 'b@test.invalid'), ev('2030-05-30', '2030-06-02', 'a@test.invalid')];
  const first = await reconcileConflicts(t.db, snap(events), T1);
  assert.equal(first.newConflicts.length, 2);
  const again = await reconcileConflicts(t.db, snap([...events].reverse()), T2);
  assert.deepEqual(again, { newConflicts: [], active: 2 });
  assert.deepEqual((await rows()).map((r) => [r.conflict_start, r.conflict_end, r.detected_at, r.last_seen_at]).sort(), [
    ['2030-06-01', '2030-06-02', T1.toISOString(), T2.toISOString()],
    ['2030-06-08', '2030-06-10', T1.toISOString(), T2.toISOString()],
  ]);
});

test('stejný snapshot opakovaně: žádné duplicity ani nová upozornění', async () => {
  await reserve('2030-07-01', '2030-07-04');
  const s = snap([ev('2030-07-02', '2030-07-03')]);
  assert.equal((await reconcileConflicts(t.db, s, T1)).newConflicts.length, 1);
  for (const now of [T2, T3]) assert.deepEqual(await reconcileConflicts(t.db, s, now), { newConflicts: [], active: 1 });
  assert.equal((await rows()).length, 1);
  assert.equal((await pendingConflictNotifications(t.db)).length, 1);
});

test('upozornění: po odeslání se pro tutéž kolizi znovu nepožaduje; nová kolize ano', async () => {
  const a = await reserve('2030-07-01', '2030-07-04');
  await reconcileConflicts(t.db, snap([ev('2030-07-02', '2030-07-03')]), T1);
  const pending = await pendingConflictNotifications(t.db);
  assert.deepEqual(pending.map((p) => [p.reservationCode, p.start, p.end]), [[a.publicCode, '2030-07-02', '2030-07-03']]);
  await markConflictsNotified(t.db, pending.map((p) => p.id), T2);
  await reconcileConflicts(t.db, snap([ev('2030-07-02', '2030-07-03')]), T3);
  assert.deepEqual(await pendingConflictNotifications(t.db), []);
  await reconcileConflicts(t.db, snap([ev('2030-07-02', '2030-07-03'), ev('2030-07-03', '2030-07-05', 'dalsi@test.invalid')]), T3);
  assert.equal((await pendingConflictNotifications(t.db)).length, 1);
});

test('cizí událost zmizí z úplného snapshotu → kolize vyřešená (historie zůstává)', async () => {
  await reserve('2030-08-01', '2030-08-04');
  await reconcileConflicts(t.db, snap([ev('2030-08-02', '2030-08-05')]), T1);
  assert.deepEqual(await reconcileConflicts(t.db, snap([]), T2), { newConflicts: [], active: 0 });
  const [row] = await rows();
  assert.equal(row.resolved_at, T2.toISOString());
  // Znovu se objeví → nová kolize (nový záznam i nové upozornění).
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-08-02', '2030-08-05')]), T3)).newConflicts.length, 1);
  assert.equal((await rows()).length, 2);
});

test('neúplný snapshot (vynechané události): kolize zůstává aktivní, nové se přidají', async () => {
  await reserve('2030-08-01', '2030-08-04');
  await reserve('2030-09-01', '2030-09-04');
  await reconcileConflicts(t.db, snap([ev('2030-08-02', '2030-08-05')]), T1);
  const partial = await reconcileConflicts(t.db, snap([ev('2030-09-02', '2030-09-03', 'nova@test.invalid')], false), T2);
  assert.equal(partial.newConflicts.length, 1);
  assert.equal(partial.active, 2, 'kolize chybějící v neúplném snapshotu se neuzavře');
});

test('zrušená vlastní rezervace nemá aktivní kolizi', async () => {
  const a = await reserve('2030-10-01', '2030-10-04');
  await reconcileConflicts(t.db, snap([ev('2030-10-02', '2030-10-03')]), T1);
  await cancelReservation(t.db, a.id, T2.toISOString());
  assert.equal((await reconcileConflicts(t.db, snap([ev('2030-10-02', '2030-10-03')], false), T2)).active, 0);
  assert.equal((await rows())[0].resolved_at, T2.toISOString());
});

test('souběžné běhy: žádné duplicity; starší běh neuzavře kolizi obnovenou novějším', async () => {
  await reserve('2030-11-01', '2030-11-05');
  const s = snap([ev('2030-11-02', '2030-11-03')]);
  await Promise.all([reconcileConflicts(t.db, s, T1), reconcileConflicts(t.db, s, T1), reconcileConflicts(t.db, s, T2)]);
  assert.equal((await rows()).length, 1);
  // Novější běh (T3) kolizi viděl; starší běh (T2) s úplným snapshotem bez události ji neuzavře.
  await reconcileConflicts(t.db, s, T3);
  await reconcileConflicts(t.db, snap([]), T2);
  assert.equal((await active()).length, 1);
});

test('událost bez UID: kolize podle nocí, deterministický otisk i při posunu rozsahu', async () => {
  await reserve('2030-12-01', '2030-12-05');
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//CS\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20301203\r\nDTEND;VALUE=DATE:20301208\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const parsed = parseCalendarEvents(text, RANGE);
  assert.equal(parsed.events[0].uid, null);
  assert.equal((await reconcileConflicts(t.db, snap(parsed.events), T1)).newConflicts.length, 1);
  const shifted = { events: parseCalendarEvents(text, { from: '2030-02-01', to: RANGE.to }).events, range: { from: '2030-02-01', to: RANGE.to }, complete: true };
  assert.deepEqual(await reconcileConflicts(t.db, shifted, T2), { newConflicts: [], active: 1 });
  assert.equal((await rows()).length, 1);
});

test('opakovaná cizí událost: každý výskyt je samostatná kolize bez roztažení přes volné noci', async () => {
  const a = await reserve('2030-06-01', '2030-06-12');
  // Dva výskyty se stejným UID (2.–4. 6. a 9.–11. 6.), mezi nimi volné noci 4.–8. 6.
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//CS\r\nBEGIN:VEVENT\r\nUID:opakovana@test.invalid\r\nDTSTART;VALUE=DATE:20300602\r\nDTEND;VALUE=DATE:20300604\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const { events } = parseCalendarEvents(text, RANGE);
  assert.deepEqual(events.map((e) => [e.uid, e.recurrenceId, e.start, e.end]), [
    ['opakovana@test.invalid', '2030-06-02', '2030-06-02', '2030-06-04'],
    ['opakovana@test.invalid', '2030-06-09', '2030-06-09', '2030-06-11'],
  ]);
  const first = await reconcileConflicts(t.db, snap(events), T1);
  assert.deepEqual([...first.newConflicts].sort((x, y) => (x.start < y.start ? -1 : 1)), [
    { reservationCode: a.publicCode, start: '2030-06-02', end: '2030-06-04' },
    { reservationCode: a.publicCode, start: '2030-06-09', end: '2030-06-11' },
  ]);
  assert.equal(first.active, 2);
  assert.deepEqual(await reconcileConflicts(t.db, snap(events), T2), { newConflicts: [], active: 2 });
  assert.deepEqual((await rows()).map((r) => [r.conflict_start, r.conflict_end, r.detected_at, r.last_seen_at]).sort(), [
    ['2030-06-02', '2030-06-04', T1.toISOString(), T2.toISOString()],
    ['2030-06-09', '2030-06-11', T1.toISOString(), T2.toISOString()],
  ]);
});

test('rezervace mimo celý rozsah snapshotu se nevyhodnocují ani neuzavírají', async () => {
  await reserve('2030-01-05', '2030-01-12'); // začala před rozsahem
  await t.db.prepare(`INSERT INTO reservation_conflicts (reservation_id, external_fingerprint, conflict_start, conflict_end, detected_at, last_seen_at) SELECT id, 'x', '2030-01-10', '2030-01-11', 'a', 'a' FROM reservations`).run();
  assert.equal((await reconcileConflicts(t.db, snap([]), T1)).active, 1);
});

test('runConflictReconciliation: nesoulad prostředí nic nezapíše; logy bez osobních údajů', async () => {
  await reserve('2030-03-01', '2030-03-05');
  const logs: string[] = [];
  const s = snap([ev('2030-03-02', '2030-03-03')]);
  assert.equal(await runConflictReconciliation({ DB: t.db, BOOKING_ENV: 'production' }, s, T1, (m) => logs.push(m)), null);
  assert.equal((await rows()).length, 0);
  await runConflictReconciliation({ DB: t.db, BOOKING_ENV: 'preview' }, s, T2, (m) => logs.push(m));
  assert.deepEqual(logs, ['conflicts: database environment mismatch', 'conflicts: 1 new, 1 active']);
  const failing = { DB: { prepare: () => { throw new Error('D1_ERROR'); } } as unknown as D1Database, BOOKING_ENV: 'preview' };
  assert.equal(await runConflictReconciliation(failing, s, T3, (m) => logs.push(m)), null);
  assert.equal(logs.at(-1), 'conflicts: reconciliation failed');
  assert.ok(!logs.join().match(/Testovací|example\.invalid|CV-|airbnb/));
});

// Napojení na GET /api/availability

const ICS = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//CS\r\n${events}END:VCALENDAR\r\n`;
const VEVENT = (uid: string, start: string, end: string) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}\r\nEND:VEVENT\r\n`;

function availabilityDeps(upstream: () => Promise<Response>, now: () => Date) {
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const env = { DB: t.db, BOOKING_ENV: 'preview' };
  const deps: AvailabilityDeps = {
    fetch: (async () => upstream()) as unknown as typeof fetch,
    now,
    cache: null,
    defer: (p) => pending.push(p),
    log: (m) => logs.push(m),
    onFreshSnapshot: (snapshot, at) => runConflictReconciliation(env, snapshot, at, (m) => logs.push(m)),
  };
  return { deps, logs, flush: () => Promise.all(pending.splice(0)) };
}

test('/api/availability: čerstvý export spustí detekci, výpadek ani neúplný export kolizi neuzavřou', async () => {
  resetAvailabilityMemory();
  await reserve('2030-03-01', '2030-03-05');
  let now = new Date('2030-01-10T10:00:00Z');
  let body: Response | null = new Response(ICS(VEVENT('airbnb-77@test.invalid', '20300303', '20300306')));
  const a = availabilityDeps(async () => (body ? body.clone() : new Response('down', { status: 503 })), () => now);
  const url = { ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics' };

  const first = await getAvailability(url, a.deps);
  await a.flush();
  assert.equal(first.status, 'ok');
  assert.equal((await active()).length, 1);
  assert.ok(a.logs.includes('conflicts: 1 new, 1 active'));

  // Výpadek e-chalup (stale): detekce se nespouští, kolize trvá.
  body = null;
  now = new Date('2030-01-10T10:06:00Z');
  assert.equal((await getAvailability(url, a.deps)).status, 'stale');
  await a.flush();
  assert.equal((await active()).length, 1);

  // Neúplný export bez cizí události: kolize se neuzavře.
  resetAvailabilityMemory();
  body = new Response(ICS('BEGIN:VEVENT\r\nUID:vadna@test.invalid\r\nSUMMARY:bez data\r\nEND:VEVENT\r\n'));
  now = new Date('2030-01-10T10:20:00Z');
  assert.equal((await getAvailability(url, a.deps)).status, 'partial');
  await a.flush();
  assert.equal((await active()).length, 1);

  // Úplný export bez cizí události: kolize vyřešená.
  resetAvailabilityMemory();
  body = new Response(ICS(''));
  now = new Date('2030-01-10T10:30:00Z');
  await getAvailability(url, a.deps);
  await a.flush();
  assert.equal((await active()).length, 0);
});

test('/api/availability: chyba detekce kalendář nerozbije a odpověď na ni nečeká', async () => {
  resetAvailabilityMemory();
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const result = await getAvailability({ ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics' }, {
    fetch: (async () => new Response(ICS(VEVENT('a@test.invalid', '20300303', '20300306')))) as unknown as typeof fetch,
    now: () => new Date('2030-01-10T10:00:00Z'),
    cache: null,
    defer: (p) => pending.push(p),
    log: (m) => logs.push(m),
    onFreshSnapshot: () => new Promise((_, reject) => setTimeout(() => reject(new Error('D1')), 20)),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.busy.length, 1);
  assert.equal(pending.length, 1, 'detekce běží odloženě');
  await Promise.all(pending);
  assert.deepEqual(logs, ['conflicts: reconciliation failed']);
});
