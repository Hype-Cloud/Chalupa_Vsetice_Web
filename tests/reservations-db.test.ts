import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateError, insertReservation, listReservedNights, NightsTakenError, nightsOf, type NewReservation } from '../worker/booking/db.ts';
import { icalUidFor } from '../lib/booking/codes.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';

// Jen smyšlené rezervace (rok 2030, domény .invalid).
let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase()));
after(() => t.dispose());
beforeEach(() => t.reset());

let counter = 0;
function reservation(arrival: string, departure: string, overrides: Partial<NewReservation> = {}): NewReservation {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  return {
    id,
    publicCode: `CV-${String(counter).padStart(6, '0')}`,
    icalUid: icalUidFor(id),
    arrival,
    departure,
    guests: 2,
    firstName: 'Smyšlený',
    lastName: 'Host',
    phone: '+420 000 000 000',
    email: 'host@example.invalid',
    priceCzk: 3000,
    idempotencyKey: null,
    requestHash: null,
    vsPrefix: '30',
    createdAt: '2030-01-10T10:00:00.000Z',
    ...overrides,
  };
}

test('založení rezervace: VS z čítače, stav čeká na platbu, všechny noci obsazené', async () => {
  const created = await insertReservation(t.db, reservation('2030-03-01', '2030-03-04'));
  assert.equal(created.variableSymbol, '30000001');
  assert.equal(created.status, 'pending_payment');
  const nights = await t.db.prepare('SELECT night FROM reserved_nights ORDER BY night').all<{ night: string }>();
  assert.deepEqual(nights.results.map((r) => r.night), ['2030-03-01', '2030-03-02', '2030-03-03']);
  assert.equal((await insertReservation(t.db, reservation('2030-04-01', '2030-04-02'))).variableSymbol, '30000002');
});

test('překryvy: stejný termín, částečný překryv i pobyt uvnitř jiného se odmítnou', async () => {
  await insertReservation(t.db, reservation('2030-03-10', '2030-03-15'));
  for (const [arrival, departure] of [
    ['2030-03-10', '2030-03-15'],
    ['2030-03-08', '2030-03-11'],
    ['2030-03-14', '2030-03-20'],
    ['2030-03-12', '2030-03-13'],
    ['2030-03-01', '2030-03-30'],
  ]) {
    await assert.rejects(insertReservation(t.db, reservation(arrival, departure)), NightsTakenError, `${arrival}–${departure}`);
  }
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 5);
});

test('navazující pobyty: den odjezdu jedněch je dnem příjezdu dalších', async () => {
  await insertReservation(t.db, reservation('2030-03-10', '2030-03-15'));
  await insertReservation(t.db, reservation('2030-03-15', '2030-03-17'));
  await insertReservation(t.db, reservation('2030-03-08', '2030-03-10'));
  assert.equal(await t.count('reservations'), 3);
});

test('neúspěšný batch se vrátí celý: žádná rezervace, žádné noci, čítač VS beze změny', async () => {
  await insertReservation(t.db, reservation('2030-03-12', '2030-03-13'));
  assert.equal(await t.sequence(), 1);
  // Kolize až na poslední noci: předchozí noci a rezervace se v batchi už vložily a musí se vrátit.
  await assert.rejects(insertReservation(t.db, reservation('2030-03-09', '2030-03-13')), NightsTakenError);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 1);
  assert.equal(await t.sequence(), 1, 'VS se při neúspěchu nespotřebuje');
  assert.equal((await insertReservation(t.db, reservation('2030-03-20', '2030-03-21'))).variableSymbol, '30000002');
});

test('souběh: 20 současných rezervací na stejný termín → právě jedna uspěje', async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => insertReservation(t.db, reservation('2030-05-01', '2030-05-05'))));
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof NightsTakenError);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 4);
  assert.equal(await t.sequence(), 1);
});

test('souběh: částečně se překrývající rezervace → žádná noc není obsazená dvakrát', async () => {
  const stays = [
    ['2030-06-01', '2030-06-05'],
    ['2030-06-03', '2030-06-07'],
    ['2030-06-04', '2030-06-06'],
    ['2030-06-06', '2030-06-09'],
    ['2030-06-08', '2030-06-10'],
  ];
  await Promise.allSettled(stays.map(([a, d]) => insertReservation(t.db, reservation(a, d))));
  const rows = await t.db
    .prepare('SELECT r.arrival, r.departure, count(n.night) AS nights FROM reservations r JOIN reserved_nights n ON n.reservation_id = r.id GROUP BY r.id ORDER BY r.arrival')
    .all<{ arrival: string; departure: string; nights: number }>();
  // Každá uložená rezervace má všechny své noci a rezervace se navzájem nepřekrývají.
  for (const row of rows.results) assert.equal(row.nights, nightsOf(row.arrival, row.departure).length);
  for (let i = 1; i < rows.results.length; i++) assert.ok(rows.results[i].arrival >= rows.results[i - 1].departure);
  assert.ok(rows.results.length >= 2);
});

test('souběh: různé termíny dostanou unikátní VS bez mezer', async () => {
  const days = Array.from({ length: 12 }, (_, i) => `2030-07-${String(i * 2 + 1).padStart(2, '0')}`);
  const created = await Promise.all(days.map((day, i) => insertReservation(t.db, reservation(day, `2030-07-${String(i * 2 + 2).padStart(2, '0')}`))));
  const symbols = created.map((r) => r.variableSymbol).sort();
  assert.deepEqual(symbols, Array.from({ length: 12 }, (_, i) => `30${String(i + 1).padStart(6, '0')}`));
});

test('unikátní veřejný kód, iCal UID a idempotency key hlídá databáze', async () => {
  await insertReservation(t.db, reservation('2030-08-01', '2030-08-02', { publicCode: 'CV-AAAAAA', idempotencyKey: 'klic-0000000000000001' }));
  await assert.rejects(insertReservation(t.db, reservation('2030-08-05', '2030-08-06', { publicCode: 'CV-AAAAAA' })), (e) => e instanceof DuplicateError && e.column === 'public_code');
  await assert.rejects(insertReservation(t.db, reservation('2030-08-05', '2030-08-06', { idempotencyKey: 'klic-0000000000000001' })), (e) => e instanceof DuplicateError && e.column === 'idempotency_key');
  const uid = (await t.db.prepare('SELECT ical_uid FROM reservations').first<{ ical_uid: string }>())!.ical_uid;
  await assert.rejects(insertReservation(t.db, reservation('2030-08-05', '2030-08-06', { icalUid: uid })), (e) => e instanceof DuplicateError && e.column === 'ical_uid');
  assert.equal(await t.count('reserved_nights'), 1);
});

test('CHECK omezení odmítnou neplatná data i mimo validaci Workeru', async () => {
  await assert.rejects(insertReservation(t.db, reservation('2030-09-01', '2030-09-02', { guests: 8 })), /CHECK constraint failed/);
  await assert.rejects(insertReservation(t.db, reservation('2030-09-01', '2030-09-02', { priceCzk: 0 })), /CHECK constraint failed/);
  await assert.rejects(
    t.db.prepare(`INSERT INTO reservations (id, public_code, arrival, departure, guests, first_name, last_name, phone, email, price_czk, variable_symbol, ical_uid, created_at, updated_at)
      VALUES ('x', 'CV-X', '2030-09-05', '2030-09-04', 2, 'A', 'B', '+420000000000', 'a@b.invalid', 1, '1', 'u', 'now', 'now')`).run(),
    /CHECK constraint failed/,
  );
  await insertReservation(t.db, reservation('2030-09-10', '2030-09-11'));
  await assert.rejects(t.db.prepare(`UPDATE reservations SET status = 'expired'`).run(), /CHECK constraint failed/);
  await assert.rejects(t.db.prepare(`INSERT INTO reserved_nights (night, reservation_id) VALUES ('2030-09-20', 'neexistuje')`).run(), /FOREIGN KEY constraint failed/);
});

test('výpadek databáze při zápisu: chyba se propaguje, nic se nezapíše', async () => {
  await assert.rejects(insertReservation(failingDatabase(t.db, 'batch'), reservation('2030-10-01', '2030-10-03')), /Network connection lost/);
  assert.equal(await t.count('reservations'), 0);
});

test('obsazenost pro /api/availability: sloučené intervaly, bez zrušených rezervací', async () => {
  await insertReservation(t.db, reservation('2030-03-01', '2030-03-04'));
  await insertReservation(t.db, reservation('2030-03-04', '2030-03-06'));
  const cancelled = reservation('2030-04-01', '2030-04-03');
  await insertReservation(t.db, cancelled);
  await t.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(cancelled.id).run();
  assert.deepEqual(await listReservedNights(t.db, { from: '2030-01-01', to: '2031-01-01' }), [{ start: '2030-03-01', end: '2030-03-06' }]);
  assert.deepEqual(await listReservedNights(t.db, { from: '2030-03-02', to: '2030-03-03' }), [{ start: '2030-03-02', end: '2030-03-03' }]);
});
