import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cancelReservation, DuplicateError, insertReservation, listReservedNights, NightsTakenError, nightsOf, ReservationCodesExhaustedError, type NewReservation } from '../worker/booking/db.ts';
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
    createdAt: '2030-01-10T10:00:00.000Z',
    ...overrides,
  };
}

// createdAt rezervací v testech: 2030-01-10T10:00Z = 10. 1. 2030 v Praze → kódy 100130NN.
const DAY = '2030-01-10';

test('založení rezervace: kód DDMMYYNN z denního čítače = VS, stav čeká na platbu, splatnost +24 h', async () => {
  const created = await insertReservation(t.db, reservation('2030-03-01', '2030-03-04'));
  assert.equal(created.code, '10013001');
  assert.equal(created.variableSymbol, created.code);
  assert.equal(created.status, 'pending_payment');
  assert.equal(created.paymentDueAt, '2030-01-11T10:00:00.000Z');
  const row = await t.db.prepare('SELECT public_code, variable_symbol, payment_due_at, created_at FROM reservations').first();
  assert.deepEqual(row, { public_code: '10013001', variable_symbol: '10013001', payment_due_at: '2030-01-11T10:00:00.000Z', created_at: '2030-01-10T10:00:00.000Z' });
  const nights = await t.db.prepare('SELECT night FROM reserved_nights ORDER BY night').all<{ night: string }>();
  assert.deepEqual(nights.results.map((r) => r.night), ['2030-03-01', '2030-03-02', '2030-03-03']);
  assert.equal((await insertReservation(t.db, reservation('2030-04-01', '2030-04-02'))).code, '10013002');
});

test('kód podle pražského dne: 22:30 UTC je už další den v Praze; nový den začíná od 01', async () => {
  // Zima (UTC+1): pražská půlnoc je 23:00 UTC.
  assert.equal((await insertReservation(t.db, reservation('2030-03-01', '2030-03-03', { createdAt: '2030-01-10T22:59:59.000Z' }))).code, '10013001');
  assert.equal((await insertReservation(t.db, reservation('2030-03-05', '2030-03-07', { createdAt: '2030-01-10T23:00:00.000Z' }))).code, '11013001');
  // Léto (UTC+2): 2030-10-09T22:30Z = 10. 10. 2030 00:30 v Praze.
  assert.equal((await insertReservation(t.db, reservation('2030-11-01', '2030-11-03', { createdAt: '2030-10-09T21:59:00.000Z' }))).code, '09103001');
  assert.equal((await insertReservation(t.db, reservation('2030-11-05', '2030-11-07', { createdAt: '2030-10-09T22:30:00.000Z' }))).code, '10103001');
  assert.equal((await insertReservation(t.db, reservation('2030-11-10', '2030-11-12', { createdAt: '2030-10-09T23:10:00.000Z' }))).code, '10103002');
  // Splatnost je absolutních 24 h v UTC (i přes změnu času 27. 10. 2030).
  const dst = await insertReservation(t.db, reservation('2030-12-01', '2030-12-03', { createdAt: '2030-10-26T12:00:00.000Z' }));
  assert.equal(dst.paymentDueAt, '2030-10-27T12:00:00.000Z');
});

test('limit 99 rezervací za pražský den: 100. se nezaloží (fail closed), čítač nepřeteče', async () => {
  await t.db.prepare('INSERT INTO reservation_code_counters (day, last) VALUES (?1, 98)').bind(DAY).run();
  assert.equal((await insertReservation(t.db, reservation('2030-03-01', '2030-03-03'))).code, '10013099');
  await assert.rejects(insertReservation(t.db, reservation('2030-03-05', '2030-03-07')), ReservationCodesExhaustedError);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 2);
  assert.equal(await t.codeCounter(DAY), 99);
  // Další den se čísluje znovu od 01.
  assert.equal((await insertReservation(t.db, reservation('2030-03-05', '2030-03-07', { createdAt: '2030-01-11T10:00:00.000Z' }))).code, '11013001');
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

test('neúspěšný batch se vrátí celý: žádná rezervace, žádné noci, čítač kódu beze změny', async () => {
  await insertReservation(t.db, reservation('2030-03-12', '2030-03-13'));
  assert.equal(await t.codeCounter(DAY), 1);
  // Kolize až na poslední noci: předchozí noci a rezervace se v batchi už vložily a musí se vrátit.
  await assert.rejects(insertReservation(t.db, reservation('2030-03-09', '2030-03-13')), NightsTakenError);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 1);
  assert.equal(await t.codeCounter(DAY), 1, 'čítač se vrátil spolu s batchem');
  assert.equal((await insertReservation(t.db, reservation('2030-03-20', '2030-03-21'))).code, '10013002');
});

test('souběh: 20 současných rezervací na stejný termín → právě jedna uspěje', async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => insertReservation(t.db, reservation('2030-05-01', '2030-05-05'))));
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof NightsTakenError);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 4);
  assert.equal(await t.codeCounter(DAY), 1);
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

test('souběh: různé termíny ve stejném dni dostanou unikátní kódy 01–12 (atomický čítač v D1)', async () => {
  const days = Array.from({ length: 12 }, (_, i) => `2030-07-${String(i * 2 + 1).padStart(2, '0')}`);
  const created = await Promise.all(days.map((day, i) => insertReservation(t.db, reservation(day, `2030-07-${String(i * 2 + 2).padStart(2, '0')}`))));
  const codes = created.map((r) => r.code).sort();
  assert.deepEqual(codes, Array.from({ length: 12 }, (_, i) => `100130${String(i + 1).padStart(2, '0')}`));
  assert.ok(created.every((r) => r.variableSymbol === r.code));
  assert.equal(await t.codeCounter(DAY), 12);
});

test('unikátní veřejný kód, iCal UID a idempotency key hlídá databáze', async () => {
  await insertReservation(t.db, reservation('2030-08-01', '2030-08-02', { idempotencyKey: 'klic-0000000000000001' }));
  // Poškozený čítač (ručně vynulovaný) by vydal už použitý kód – odmítne ho UNIQUE na public_code
  // i variable_symbol (obsahují stejnou hodnotu; SQLite nahlásí první porušený index).
  await t.db.prepare('DELETE FROM reservation_code_counters').run();
  await assert.rejects(insertReservation(t.db, reservation('2030-08-05', '2030-08-06')), (e) => e instanceof DuplicateError && (e.column === 'public_code' || e.column === 'variable_symbol'));
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

const nightsOfReservation = async (id: string) =>
  (await t.db.prepare('SELECT count(*) AS n FROM reserved_nights WHERE reservation_id = ?1').bind(id).first<{ n: number }>())!.n;
const statusOf = async (id: string) =>
  (await t.db.prepare('SELECT status, ical_sequence AS seq FROM reservations WHERE id = ?1').bind(id).first<{ status: string; seq: number }>())!;

test('zrušení: noci se atomicky uvolní, rezervace zůstane v historii, SEQUENCE +1', async () => {
  const r = reservation('2030-11-01', '2030-11-04');
  await insertReservation(t.db, r);
  assert.equal(await cancelReservation(t.db, r.id, '2030-01-11T10:00:00.000Z'), true);
  assert.equal(await nightsOfReservation(r.id), 0);
  assert.deepEqual(await statusOf(r.id), { status: 'cancelled', seq: 1 });
  assert.equal(await t.count('reservations'), 1, 'historie zůstává');
});

test('opakované zrušení nic nemění; neexistující rezervace vrátí false', async () => {
  const r = reservation('2030-11-01', '2030-11-04');
  await insertReservation(t.db, r);
  await cancelReservation(t.db, r.id, '2030-01-11T10:00:00.000Z');
  assert.equal(await cancelReservation(t.db, r.id, '2030-01-12T10:00:00.000Z'), false);
  assert.deepEqual(await statusOf(r.id), { status: 'cancelled', seq: 1 });
  assert.equal(await cancelReservation(t.db, 'neexistuje', '2030-01-12T10:00:00.000Z'), false);
});

test('uvolněný termín lze znovu rezervovat; zrušenou rezervaci nelze znovu aktivovat', async () => {
  const r = reservation('2030-11-01', '2030-11-04');
  await insertReservation(t.db, r);
  await assert.rejects(insertReservation(t.db, reservation('2030-11-02', '2030-11-03')), NightsTakenError);
  await cancelReservation(t.db, r.id, '2030-01-11T10:00:00.000Z');
  const next = reservation('2030-11-02', '2030-11-05');
  await insertReservation(t.db, next);
  assert.equal(await nightsOfReservation(next.id), 3);
  await assert.rejects(t.db.prepare(`UPDATE reservations SET status = 'pending_payment' WHERE id = ?1`).bind(r.id).run(), /cannot be reactivated/);
  assert.deepEqual(await listReservedNights(t.db, { from: '2030-01-01', to: '2031-01-01' }), [{ start: '2030-11-02', end: '2030-11-05' }]);
});

test('zrušení je atomické: při selhání transakce zůstane stav i noci beze změny (rollback)', async () => {
  const r = reservation('2030-11-01', '2030-11-04');
  await insertReservation(t.db, r);
  await assert.rejects(
    t.db.batch([
      t.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(r.id),
      t.db.prepare(`INSERT INTO reserved_nights (night, reservation_id) VALUES ('2030-11-20', 'neexistuje')`),
    ]),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal((await statusOf(r.id)).status, 'pending_payment');
  assert.equal(await nightsOfReservation(r.id), 3);
  await assert.rejects(insertReservation(t.db, reservation('2030-11-01', '2030-11-02')), NightsTakenError);
});

test('ruční zrušení přes UPDATE (wrangler d1 execute) noci také uvolní', async () => {
  const r = reservation('2030-11-01', '2030-11-04');
  await insertReservation(t.db, r);
  await t.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(r.id).run();
  assert.equal(await nightsOfReservation(r.id), 0);
});

test('ruční zrušení přes UPDATE zvýší SEQUENCE i čas změny (trigger 0003)', async () => {
  const r = reservation('2030-12-01', '2030-12-03');
  await insertReservation(t.db, r);
  await t.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(r.id).run();
  const row = (await t.db.prepare('SELECT status, ical_sequence AS seq, updated_at FROM reservations WHERE id = ?1').bind(r.id).first<{ status: string; seq: number; updated_at: string }>())!;
  assert.equal(row.status, 'cancelled');
  assert.equal(row.seq, 1);
  assert.notEqual(row.updated_at, r.createdAt);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(await nightsOfReservation(r.id), 0);
});

test('cancelReservation zvýší SEQUENCE právě o 1 (trigger nepřičte podruhé)', async () => {
  const r = reservation('2030-12-10', '2030-12-12');
  await insertReservation(t.db, r);
  await cancelReservation(t.db, r.id, '2030-01-11T10:00:00.000Z');
  assert.deepEqual(await statusOf(r.id), { status: 'cancelled', seq: 1 });
  const updated = (await t.db.prepare('SELECT updated_at FROM reservations WHERE id = ?1').bind(r.id).first<{ updated_at: string }>())!.updated_at;
  assert.equal(updated, '2030-01-11T10:00:00.000Z');
});

test('změna stavu mimo zrušení SEQUENCE nemění', async () => {
  const r = reservation('2030-12-20', '2030-12-22');
  await insertReservation(t.db, r);
  await t.db.prepare(`UPDATE reservations SET status = 'paid' WHERE id = ?1`).bind(r.id).run();
  assert.deepEqual(await statusOf(r.id), { status: 'paid', seq: 0 });
});
