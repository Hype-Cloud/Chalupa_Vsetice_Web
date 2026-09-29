import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleCreateReservation, type BookingDeps, type BookingEnv } from '../worker/booking/handler.ts';
import { getAvailability, resetAvailabilityMemory } from '../worker/availability.ts';
import { listReservedNights } from '../worker/booking/db.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Jen smyšlené údaje. Export e-chalup nahrazují syntetické fixtures:
// 01-single-and-multi.ics obsazuje noci 15. 1. a 20.–24. 1. 2030.
const SECRET_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const TOKEN = 'testovaci-token-0123456789';
const NOW = new Date('2030-01-10T10:00:00Z');
const GUEST = { firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid' };

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(() => t.reset());

function setup(upstream: () => Promise<Response> = async () => new Response(fixture('01-single-and-multi.ics')), envOverrides: Partial<BookingEnv> = {}) {
  const logs: string[] = [];
  const requests: string[] = [];
  let uuid = 0;
  const env: BookingEnv = { ECHALUPY_ICAL_URL: SECRET_URL, DB: t.db, BOOKING_ENV: 'preview', BOOKING_API_ENABLED: 'true', BOOKING_API_TOKEN: TOKEN, ...envOverrides };
  const deps: BookingDeps = {
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return upstream();
    }) as typeof fetch,
    now: () => NOW,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    log: (message) => logs.push(message),
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleCreateReservation(
      new Request('https://preview.test.invalid/api/reservations', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
      deps,
    );
  return { env, deps, logs, requests, post };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (response: Response): Promise<any> => response.json();

const stay = (arrival: string, departure: string, extra: Record<string, unknown> = {}) => ({ arrival, departure, guests: 2, ...GUEST, ...extra });

test('úspěšná rezervace: 201, cena ze serveru, VS, bez kontaktních údajů v odpovědi', async () => {
  const s = setup();
  const response = await s.post(stay('2030-02-01', '2030-02-04', { priceCzk: 1, price: 1, expectedPriceCzk: 9000 }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await read(response);
  assert.deepEqual({ ...body.reservation, code: 'x' }, { code: 'x', arrival: '2030-02-01', departure: '2030-02-04', nights: 3, guests: 2, priceCzk: 9000, variableSymbol: '30000001', status: 'pending_payment' });
  assert.match(body.reservation.code, /^CV-[0-9A-HJKMNP-TV-Z]{6}$/);
  const text = JSON.stringify(body) + s.logs.join('\n');
  for (const secret of ['Testovací', 'test@example.invalid', '000 000', 'SECRET-TOKEN-123']) assert.ok(!text.includes(secret), secret);
  const row = await t.db.prepare('SELECT price_czk, ical_uid, first_name FROM reservations').first<{ price_czk: number; ical_uid: string; first_name: string }>();
  assert.equal(row!.price_czk, 9000);
  assert.equal(row!.first_name, 'Jan');
  assert.equal(row!.ical_uid, 'rezervace-00000000-0000-4000-8000-000000000001@chalupavsetice.cz');
  assert.equal(s.requests.length, 1, 'export se před zápisem stáhne čerstvě');
});

test('cena z prohlížeče se nepoužije: nesouhlasí-li očekávaná cena, rezervace nevznikne', async () => {
  const s = setup();
  const response = await s.post(stay('2030-02-01', '2030-02-04', { expectedPriceCzk: 3000 }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'price-mismatch', priceCzk: 9000 });
  assert.equal(await t.count('reservations'), 0);
});

test('kolize s exportem e-chalup (Airbnb/Booking/ruční rezervace) → 409, nic se nezapíše', async () => {
  const s = setup();
  for (const [arrival, departure] of [
    ['2030-01-15', '2030-01-16'],
    ['2030-01-14', '2030-01-17'],
    ['2030-01-24', '2030-01-26'],
  ]) {
    const response = await s.post(stay(arrival, departure));
    assert.equal(response.status, 409, `${arrival}–${departure}`);
    assert.deepEqual(await response.json(), { error: 'dates-unavailable' });
  }
  assert.equal(await t.count('reservations'), 0);
  // Navazující pobyt (odjezd v den příjezdu cizích hostů) je v pořádku.
  assert.equal((await s.post(stay('2030-01-17', '2030-01-20'))).status, 201);
});

test('neúplný iCal (vynechané události) → 503, rezervace se odmítne', async () => {
  const s = setup(async () => new Response(fixture('19-invalid-events.ics')));
  const response = await s.post(stay('2030-06-01', '2030-06-03'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'availability-incomplete' });
  assert.equal(await t.count('reservations'), 0);
});

test('selhání kontroly e-chalup (HTTP chyba, síť, neplatný iCal) → 503, nic se nezapíše', async () => {
  const upstreams: [string, () => Promise<Response>][] = [
    ['http', async () => new Response('down', { status: 503 })],
    ['network', async () => Promise.reject(new TypeError('fetch failed'))],
    ['invalid', async () => new Response(fixture('07-invalid-html.ics'))],
  ];
  for (const [name, upstream] of upstreams) {
    const s = setup(upstream);
    const response = await s.post(stay('2030-02-01', '2030-02-03'));
    assert.equal(response.status, 503, name);
    assert.deepEqual(await response.json(), { error: 'availability-check-failed' });
    assert.ok(!s.logs.join().includes('SECRET-TOKEN-123'));
  }
  assert.equal(await t.count('reservations'), 0);
});

test('kontrola vůči e-chalupám nepoužívá cache: nová cizí rezervace se projeví hned', async () => {
  let version = '09-sync-before.ics';
  const s = setup(async () => new Response(fixture(version)));
  assert.equal((await s.post(stay('2030-01-26', '2030-01-27'))).status, 201);
  await t.reset();
  version = '09-sync-after.ics'; // obsazuje noci 26.–28. 1. 2030
  assert.equal((await s.post(stay('2030-01-26', '2030-01-27'))).status, 409);
  assert.equal(s.requests.length, 2);
});

test('souběžné požadavky na stejný termín: právě jeden uspěje, ostatní 409', async () => {
  const s = setup();
  const responses = await Promise.all(Array.from({ length: 10 }, () => s.post(stay('2030-03-01', '2030-03-05'))));
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, ...Array(9).fill(409)]);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 4);
});

test('souběžné částečně se překrývající požadavky: žádná noc dvakrát', async () => {
  const s = setup();
  const responses = await Promise.all([
    s.post(stay('2030-04-01', '2030-04-05')),
    s.post(stay('2030-04-04', '2030-04-08')),
    s.post(stay('2030-04-07', '2030-04-09')),
  ]);
  const ok = responses.filter((r) => r.status === 201).length;
  assert.ok(ok >= 1 && ok <= 2);
  const nights = await t.db.prepare('SELECT count(*) AS n, count(DISTINCT night) AS d FROM reserved_nights').first<{ n: number; d: number }>();
  assert.equal(nights!.n, nights!.d);
});

test('opakované odeslání se stejným Idempotency-Key vrátí tutéž rezervaci', async () => {
  const s = setup();
  const headers = { 'idempotency-key': 'formular-0000000000000001' };
  const first = await read(await s.post(stay('2030-05-01', '2030-05-03'), headers));
  const again = await s.post(stay('2030-05-01', '2030-05-03'), headers);
  assert.equal(again.status, 200);
  const body = await read(again);
  assert.equal(body.replayed, true);
  assert.equal(body.reservation.code, first.reservation.code);
  assert.equal(await t.count('reservations'), 1);
  const other = await s.post(stay('2030-05-10', '2030-05-12'), headers);
  assert.equal(other.status, 422);
  assert.deepEqual(await other.json(), { error: 'idempotency-key-reused' });
});

test('souběžné opakování se stejným Idempotency-Key založí jen jednu rezervaci', async () => {
  const s = setup();
  const headers = { 'idempotency-key': 'formular-0000000000000002' };
  const responses = await Promise.all(Array.from({ length: 5 }, () => s.post(stay('2030-05-20', '2030-05-22'), headers)));
  assert.ok(responses.every((r) => r.status === 201 || r.status === 200));
  const codes = new Set(await Promise.all(responses.map(async (r) => (await read(r)).reservation.code)));
  assert.equal(codes.size, 1);
  assert.equal(await t.count('reservations'), 1);
});

test('selhání databáze: 503 bez detailů, bez osobních údajů v logu', async () => {
  for (const failOn of ['read', 'batch'] as const) {
    const s = setup(undefined, { DB: failingDatabase(t.db, failOn) });
    const response = await s.post(stay('2030-06-10', '2030-06-12'));
    assert.equal(response.status, 503, failOn);
    assert.deepEqual(await response.json(), { error: 'database-error' });
    assert.ok(s.logs.includes('reservations: database error'));
    assert.ok(!s.logs.join().includes('Testovací'));
  }
  assert.equal(await t.count('reservations'), 0);
});

test('Preview nezapíše do databáze jiného prostředí (meta.environment ≠ BOOKING_ENV)', async () => {
  const s = setup(undefined, { BOOKING_ENV: 'production' });
  const response = await s.post(stay('2030-02-01', '2030-02-03'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'database-environment-mismatch' });
  assert.equal(s.requests.length, 0);
  assert.equal(await t.count('reservations'), 0);
});

test('produkce: bez BOOKING_API_ENABLED je endpoint 404 a na nic nesahá', async () => {
  for (const flag of [undefined, 'false', '1']) {
    const s = setup(undefined, { BOOKING_API_ENABLED: flag, BOOKING_ENV: 'production' });
    const response = await s.post(stay('2030-02-01', '2030-02-03'));
    assert.equal(response.status, 404);
    assert.equal(s.requests.length, 0);
  }
  assert.equal(await t.count('reservations'), 0);
});

test('přístup jen s tokenem; bez nastaveného tokenu endpoint nefunguje', async () => {
  const s = setup();
  assert.equal((await s.post(stay('2030-02-01', '2030-02-03'), { authorization: 'Bearer spatny-token' })).status, 401);
  assert.equal((await s.post(stay('2030-02-01', '2030-02-03'), { authorization: '' })).status, 401);
  assert.equal((await setup(undefined, { BOOKING_API_TOKEN: undefined }).post(stay('2030-02-01', '2030-02-03'))).status, 503);
  assert.equal((await setup(undefined, { DB: undefined }).post(stay('2030-02-01', '2030-02-03'))).status, 503);
  assert.equal(await t.count('reservations'), 0);
});

test('neplatné požadavky: 4xx s názvy polí, bez hodnot', async () => {
  const s = setup();
  const invalid = await s.post(stay('2030-01-05', '2030-01-04', { guests: 8, email: 'neplatny', phone: '12' }));
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: 'invalid-request', fields: ['arrival', 'departure', 'guests', 'phone', 'email'] });
  assert.equal((await s.post('{nevalidní json')).status, 400);
  assert.equal((await s.post(stay('2030-02-01', '2030-02-03'), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await s.post(stay('2030-02-01', '2030-02-03', { lastName: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await s.post(stay('2030-02-01', '2030-02-03'), { 'idempotency-key': 'kratky' })).status, 400);
  assert.equal(s.requests.length, 0, 'neplatný požadavek nevede ke stažení exportu');
  assert.equal(await t.count('reservations'), 0);
});

test('/api/availability zahrne vlastní rezervace z D1 hned po založení', async () => {
  resetAvailabilityMemory();
  const s = setup();
  await s.post(stay('2030-02-10', '2030-02-13'));
  const availability = await getAvailability(s.env, {
    ...s.deps,
    cache: null,
    defer: () => undefined,
    reservedNights: (range) => listReservedNights(t.db, range),
  });
  assert.equal(availability.status, 'ok');
  assert.deepEqual(availability.busy, [
    { start: '2030-01-15', end: '2030-01-16' },
    { start: '2030-01-20', end: '2030-01-25' },
    { start: '2030-02-10', end: '2030-02-13' },
  ]);
  assert.ok(!JSON.stringify(availability).includes('CV-'), 'API obsazenosti nevrací kódy ani UID');
});
