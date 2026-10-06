import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, loadPricingData, PricingDataError, quoteStay } from '../worker/booking/pricing.ts';
import { handleQuote } from '../worker/booking/quote.ts';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Očekávané ceny jsou v testech zapsané ručně (výchozí cena 3 000 Kč/noc), ne spočítané
// druhou implementací výpočtu. Jen smyšlené údaje.
const NOW = new Date('2030-01-10T10:00:00Z');

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(async () => {
  await t.db.batch([t.db.prepare('DELETE FROM daily_prices'), t.db.prepare('DELETE FROM length_discounts')]);
  await t.reset();
});

const setPrices = (prices: Record<string, number>) =>
  t.db.batch(Object.entries(prices).map(([date, price]) => t.db.prepare('INSERT INTO daily_prices (date, price_czk) VALUES (?1, ?2)').bind(date, price)));
const setDiscounts = (rules: [number, number][]) =>
  t.db.batch(rules.map(([min, pct]) => t.db.prepare('INSERT INTO length_discounts (min_nights, discount_percent) VALUES (?1, ?2)').bind(min, pct)));
const quote = (arrival: string, departure: string) => quoteStay(t.db, { arrival, departure });

test('1: bez vlastních cen a bez slevy → výchozí cena za každou noc', async () => {
  assert.deepEqual(await quote('2030-02-01', '2030-02-04'), {
    arrivalDate: '2030-02-01',
    departureDate: '2030-02-04',
    nights: 3,
    subtotalCzk: 9000,
    discount: null,
    totalCzk: 9000,
    nightlyPrices: [
      { date: '2030-02-01', priceCzk: 3000 },
      { date: '2030-02-02', priceCzk: 3000 },
      { date: '2030-02-03', priceCzk: 3000 },
    ],
  });
});

test('2: jedna noc s vlastní cenou', async () => {
  await setPrices({ '2030-02-02': 5000 });
  const q = await quote('2030-02-01', '2030-02-04');
  assert.deepEqual(q.nightlyPrices.map((n) => n.priceCzk), [3000, 5000, 3000]);
  assert.equal(q.totalCzk, 11000);
});

test('3: několik nocí s různými cenami', async () => {
  await setPrices({ '2030-02-01': 4000, '2030-02-02': 4500, '2030-02-03': 2500 });
  const q = await quote('2030-02-01', '2030-02-04');
  assert.equal(q.subtotalCzk, 11000);
  assert.equal(q.totalCzk, 11000);
});

test('4: vlastní ceny jen u části pobytu; noc odjezdu ani dny mimo pobyt se nepočítají', async () => {
  await setPrices({ '2030-01-31': 9999, '2030-02-03': 6000, '2030-02-04': 7000, '2030-02-05': 8000 });
  const q = await quote('2030-02-01', '2030-02-04');
  assert.deepEqual(q.nightlyPrices, [
    { date: '2030-02-01', priceCzk: 3000 },
    { date: '2030-02-02', priceCzk: 3000 },
    { date: '2030-02-03', priceCzk: 6000 },
  ]);
  assert.equal(q.totalCzk, 12000);
});

test('5: přesně na prahu množstevní slevy (7 nocí, 5 %)', async () => {
  await setDiscounts([[7, 5]]);
  const q = await quote('2030-03-01', '2030-03-08');
  assert.equal(q.nights, 7);
  assert.equal(q.subtotalCzk, 21000);
  assert.deepEqual(q.discount, { type: 'length', minNights: 7, percent: 5, amountCzk: 1050 });
  assert.equal(q.totalCzk, 19950);
});

test('6: těsně pod prahem slevy (6 nocí) → bez slevy', async () => {
  await setDiscounts([[7, 5]]);
  const q = await quote('2030-03-01', '2030-03-07');
  assert.equal(q.discount, null);
  assert.equal(q.totalCzk, 18000);
});

test('7: více pravidel → nejvyšší odpovídající práh (16 nocí → 10 %)', async () => {
  await setDiscounts([[21, 15], [7, 5], [14, 10]]);
  const q = await quote('2030-03-01', '2030-03-17');
  assert.equal(q.nights, 16);
  assert.equal(q.subtotalCzk, 48000);
  assert.deepEqual(q.discount, { type: 'length', minNights: 14, percent: 10, amountCzk: 4800 });
  assert.equal(q.totalCzk, 43200);
  assert.equal((await quote('2030-03-01', '2030-03-22')).discount?.percent, 15, '21 nocí → 15 %');
});

test('8: zaokrouhlení – sleva se zaokrouhluje dolů na celé Kč', async () => {
  // 7 × 3 333 = 23 331 Kč; 5 % = 1 166,55 → sleva 1 166 Kč, celkem 23 331 − 1 166 = 22 165 Kč.
  await setPrices(Object.fromEntries(['01', '02', '03', '04', '05', '06', '07'].map((d) => [`2030-04-${d}`, 3333])));
  await setDiscounts([[7, 5]]);
  const q = await quote('2030-04-01', '2030-04-08');
  assert.equal(q.subtotalCzk, 23331);
  assert.equal(q.discount?.amountCzk, 1166);
  assert.equal(q.totalCzk, 22165);
  // 0 % a 100 % jsou okrajové, ale platné hodnoty.
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 100 }] }).totalCzk, 0);
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 0 }] }).totalCzk, 999);
  // 3 % z 999 = 29,97 → 29 Kč.
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 3 }] }).discount?.amountCzk, 29);
});

test('9: pobyt přes konec měsíce', async () => {
  await setPrices({ '2030-02-01': 4000 });
  const q = await quote('2030-01-30', '2030-02-02');
  assert.deepEqual(q.nightlyPrices.map((n) => n.date), ['2030-01-30', '2030-01-31', '2030-02-01']);
  assert.equal(q.totalCzk, 10000);
});

test('10: pobyt přes konec roku', async () => {
  await setPrices({ '2030-12-31': 6000, '2031-01-01': 5000 });
  const q = await quote('2030-12-30', '2031-01-02');
  assert.deepEqual(q.nightlyPrices, [
    { date: '2030-12-30', priceCzk: 3000 },
    { date: '2030-12-31', priceCzk: 6000 },
    { date: '2031-01-01', priceCzk: 5000 },
  ]);
  assert.equal(q.totalCzk, 14000);
});

// POST /api/quote

const post = (body: unknown, db: D1Database | undefined = t.db, logs: string[] = [], headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  handleQuote(new Request('https://x.invalid/api/quote', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), { DB: db }, { now: () => NOW, log: (m) => logs.push(m) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (r: Response): Promise<any> => r.json();

test('/api/quote: kontrakt odpovědi, no-store', async () => {
  await setDiscounts([[7, 5]]);
  const response = await post({ arrivalDate: '2030-12-07', departureDate: '2030-12-17', guests: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await read(response);
  assert.deepEqual({ ...body, nightlyPrices: body.nightlyPrices.length }, {
    arrivalDate: '2030-12-07', departureDate: '2030-12-17', nights: 10, subtotalCzk: 30000,
    discount: { type: 'length', minNights: 7, percent: 5, amountCzk: 1500 }, totalCzk: 28500, nightlyPrices: 10,
  });
  assert.deepEqual(body.nightlyPrices[0], { date: '2030-12-07', priceCzk: 3000 });
});

test('11: /api/quote odmítne neplatné termíny a počet hostů (422 s názvy polí)', async () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ arrivalDate: '2030-01-09', departureDate: '2030-01-12', guests: 2 }, ['arrivalDate']],
    [{ arrivalDate: '2030-02-05', departureDate: '2030-02-05', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-05', departureDate: '2030-02-01', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-01', departureDate: '2030-03-05', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-30', departureDate: '2030-03-02', guests: 2 }, ['arrivalDate']],
    [{ arrivalDate: '2031-01-11', departureDate: '2031-01-12', guests: 2 }, ['arrivalDate']],
    [{ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 8 }, ['guests']],
    [{ arrivalDate: '2030-02-01', departureDate: '2030-02-03' }, ['guests']],
  ];
  for (const [body, fields] of cases) {
    const response = await post(body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.deepEqual(await read(response), { error: 'invalid-request', fields });
  }
  assert.equal((await post('{nevalidní')).status, 400);
  assert.equal((await post([1])).status, 422);
  assert.equal((await post({}, t.db, [], { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await handleQuote(new Request('https://x.invalid/api/quote'), { DB: t.db }, { now: () => NOW, log: () => undefined })).status, 405);
});

test('12: neplatná ceníková data v D1 → 503 pricing-unavailable, nikdy tichý fallback', async () => {
  // Databázová omezení neplatná data nepustí…
  for (const sql of [
    `INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-01', 0)`,
    `INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-01', -100)`,
    `INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-01', 'tři tisíce')`,
    `INSERT INTO daily_prices (date, price_czk) VALUES ('2030-02-01', 2999.5)`,
    `INSERT INTO daily_prices (date, price_czk) VALUES ('1.2.2030', 3000)`,
    `INSERT INTO length_discounts (min_nights, discount_percent) VALUES (0, 5)`,
    `INSERT INTO length_discounts (min_nights, discount_percent) VALUES (7, 101)`,
    `INSERT INTO length_discounts (min_nights, discount_percent) VALUES (7, -1)`,
  ]) {
    await assert.rejects(t.db.prepare(sql).run(), /CHECK constraint failed/, sql);
  }
  await setDiscounts([[7, 5]]);
  await assert.rejects(setDiscounts([[7, 10]]), /UNIQUE constraint failed/);
  // …a kdyby se tam přesto dostala (ruční zásah, jiná verze schématu), výpočet se odmítne.
  const corrupt = (prices: unknown[], discounts: unknown[]) =>
    ({ prepare: () => ({ bind: () => ({}) }), batch: async () => [{ results: prices }, { results: discounts }] }) as unknown as D1Database;
  for (const db of [
    corrupt([{ date: '2030-02-01', price_czk: 0 }], []),
    corrupt([{ date: '2030-02-01', price_czk: '3000' }], []),
    corrupt([{ date: 'nesmysl', price_czk: 3000 }], []),
    corrupt([], [{ min_nights: 7, discount_percent: 150 }]),
    corrupt([], [{ min_nights: 7, discount_percent: 5 }, { min_nights: 7, discount_percent: 10 }]),
  ]) {
    await assert.rejects(loadPricingData(db, { arrival: '2030-02-01', departure: '2030-02-03' }), PricingDataError);
    const logs: string[] = [];
    const response = await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 }, db, logs);
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'pricing-unavailable' });
    assert.deepEqual(logs, ['quote: pricing data invalid']);
  }
});

test('13: chyba D1 → /api/quote 503 database-error bez detailů; bez D1 → not-configured', async () => {
  const logs: string[] = [];
  const response = await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 }, failingDatabase(t.db, 'batch'), logs);
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text, '{"error":"database-error"}');
  assert.deepEqual(logs, ['quote: database error']);
  const unconfigured = await handleQuote(
    new Request('https://x.invalid/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    {},
    { now: () => NOW, log: () => undefined },
  );
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await read(unconfigured), { error: 'not-configured' });
});

test('14: /api/quote nic nezapisuje (jen SELECT)', async () => {
  await setPrices({ '2030-02-02': 5000 });
  await setDiscounts([[2, 5]]);
  const statements: string[] = [];
  const recording = new Proxy(t.db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => (statements.push(sql), target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const before = await t.db.prepare('SELECT (SELECT count(*) FROM daily_prices) AS p, (SELECT count(*) FROM length_discounts) AS d, (SELECT count(*) FROM reservations) AS r, (SELECT value FROM sequences) AS s').first();
  assert.equal((await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-04', guests: 2 }, recording)).status, 200);
  assert.ok(statements.length > 0 && statements.every((sql) => /^\s*SELECT\b/i.test(sql)), statements.join('\n'));
  const afterState = await t.db.prepare('SELECT (SELECT count(*) FROM daily_prices) AS p, (SELECT count(*) FROM length_discounts) AS d, (SELECT count(*) FROM reservations) AS r, (SELECT value FROM sequences) AS s').first();
  assert.deepEqual(afterState, before);
});

// Integrace s POST /api/reservations

function booking() {
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: 'preview', BOOKING_API_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  let uuid = 0;
  const logs: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) =>
    String(input) === SITEVERIFY_URL ? Response.json({ success: true }) : new Response(fixture('01-single-and-multi.ics'))) as typeof fetch;
  return {
    logs,
    post: (body: Record<string, unknown>) =>
      handleCreateReservation(
        new Request('https://x.invalid/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        env,
        { fetch: fetchFn, now: () => NOW, randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, log: (m) => logs.push(m) },
      ),
  };
}
const GUEST = { guests: 2, firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' };

test('15: /api/quote a rezervace dávají pro stejný termín stejnou cenu', async () => {
  await setPrices({ '2030-02-03': 4500, '2030-02-08': 6000 });
  await setDiscounts([[7, 10]]);
  const q = await read(await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-09', guests: 2 }));
  // 6 × 3 000 + 4 500 + 6 000 = 28 500; 10 % = 2 850 → 25 650 Kč.
  assert.equal(q.totalCzk, 25650);
  const response = await booking().post({ arrival: '2030-02-01', departure: '2030-02-09', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 201);
  assert.equal((await read(response)).reservation.priceCzk, 25650);
  assert.equal((await t.db.prepare('SELECT price_czk FROM reservations').first<{ price_czk: number }>())!.price_czk, 25650);
  // Bez expectedPriceCzk se uloží cena ze serveru.
  const b = await booking().post({ arrival: '2030-03-01', departure: '2030-03-03', ...GUEST });
  assert.equal((await read(b)).reservation.priceCzk, 6000);
});

test('16: změna ceníku mezi nabídkou a rezervací → 409 price-mismatch s novou cenou, nic se nezapíše', async () => {
  const q = await read(await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 }));
  assert.equal(q.totalCzk, 6000);
  await setPrices({ '2030-02-02': 4000 });
  const response = await booking().post({ arrival: '2030-02-01', departure: '2030-02-03', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 409);
  assert.deepEqual(await read(response), { error: 'price-mismatch', priceCzk: 7000 });
  assert.equal(await t.count('reservations'), 0);
  assert.equal(await t.sequence(), 0, 'VS se nespotřebuje');
});

test('rezervace s neplatným ceníkem → 503 pricing-unavailable; výpadek D1 → database-error', async () => {
  // Neplatný ceník tu simuluje výpočet nad poškozenou tabulkou (CHECK by vložení nedovolil).
  await t.db.prepare('DROP TABLE daily_prices').run();
  await t.db.prepare(`CREATE TABLE daily_prices (date TEXT PRIMARY KEY, price_czk)`).run();
  await t.db.prepare(`INSERT INTO daily_prices VALUES ('2030-02-01', 'drahé')`).run();
  try {
    const b = booking();
    const response = await b.post({ arrival: '2030-02-01', departure: '2030-02-03', ...GUEST });
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'pricing-unavailable' });
    assert.ok(b.logs.includes('reservations: pricing data invalid'));
    assert.equal(await t.count('reservations'), 0);
  } finally {
    await t.db.prepare('DROP TABLE daily_prices').run();
    await t.db.prepare(`CREATE TABLE daily_prices (date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'), price_czk INTEGER NOT NULL CHECK (typeof(price_czk) = 'integer' AND price_czk > 0 AND price_czk <= 1000000))`).run();
  }
});

test('/api/quote při úspěchu nic neloguje', async () => {
  const logs: string[] = [];
  await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 }, t.db, logs);
  assert.deepEqual(logs, []);
});
