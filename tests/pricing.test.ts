import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, loadPricingData, PricingDataError, quoteStay } from '../worker/booking/pricing.ts';
import { handleQuote } from '../worker/booking/quote.ts';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { listReservedNights } from '../worker/booking/db.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Očekávané ceny jsou v testech zapsané ručně (výchozí cena 3 000 Kč/noc), ne spočítané
// druhou implementací výpočtu. Jen smyšlené údaje.
const NOW = new Date('2030-01-10T10:00:00Z');

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(async () => {
  await t.db.batch([t.db.prepare('DELETE FROM daily_prices'), t.db.prepare('DELETE FROM length_discounts'), t.db.prepare('DELETE FROM stay_prices')]);
  await t.reset();
});

const setPrices = (prices: Record<string, number>) =>
  t.db.batch(Object.entries(prices).map(([date, price]) => t.db.prepare('INSERT INTO daily_prices (date, price_czk) VALUES (?1, ?2)').bind(date, price)));
const setDiscounts = (rules: [number, number][]) =>
  t.db.batch(rules.map(([min, pct]) => t.db.prepare('INSERT INTO length_discounts (min_nights, discount_percent) VALUES (?1, ?2)').bind(min, pct)));
const setStayPrice = (arrival: string, departure: string, total: number) =>
  t.db
    .prepare('INSERT INTO stay_prices (arrival_date, departure_date, total_czk) VALUES (?1, ?2, ?3) ON CONFLICT(arrival_date, departure_date) DO UPDATE SET total_czk = excluded.total_czk')
    .bind(arrival, departure, total)
    .run();
const stayCount = async () => (await t.db.prepare('SELECT count(*) AS n FROM stay_prices').first<{ n: number }>())!.n;
const quote = (arrival: string, departure: string) => quoteStay(t.db, { arrival, departure });

test('1: bez vlastních cen a bez slevy → výchozí cena za každou noc', async () => {
  assert.deepEqual(await quote('2030-02-01', '2030-02-04'), {
    arrivalDate: '2030-02-01',
    departureDate: '2030-02-04',
    nights: 3,
    pricingMode: 'nightly',
    // 3 × 2 990 Kč (výchozí cena PRICE_PER_NIGHT)
    subtotalCzk: 8970,
    discount: null,
    totalCzk: 8970,
    nightlyPrices: [
      { date: '2030-02-01', priceCzk: 2990 },
      { date: '2030-02-02', priceCzk: 2990 },
      { date: '2030-02-03', priceCzk: 2990 },
    ],
  });
});

test('2: jedna noc s vlastní cenou', async () => {
  await setPrices({ '2030-02-02': 5000 });
  const q = await quote('2030-02-01', '2030-02-04');
  assert.deepEqual(q.nightlyPrices.map((n) => n.priceCzk), [2990, 5000, 2990]);
  assert.equal(q.totalCzk, 10980);
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
    { date: '2030-02-01', priceCzk: 2990 },
    { date: '2030-02-02', priceCzk: 2990 },
    { date: '2030-02-03', priceCzk: 6000 },
  ]);
  assert.equal(q.totalCzk, 11980);
});

test('5: přesně na prahu množstevní slevy (7 nocí, 5 %)', async () => {
  await setDiscounts([[7, 5]]);
  const q = await quote('2030-03-01', '2030-03-08');
  assert.equal(q.nights, 7);
  // 7 × 2 990 = 20 930 Kč; 5 % = 1 046,5 → 1 046 Kč; celkem 19 884 Kč.
  assert.equal(q.subtotalCzk, 20930);
  assert.deepEqual(q.discount, { type: 'length', minNights: 7, percent: 5, amountCzk: 1046 });
  assert.equal(q.totalCzk, 19884);
});

test('6: těsně pod prahem slevy (6 nocí) → bez slevy', async () => {
  await setDiscounts([[7, 5]]);
  const q = await quote('2030-03-01', '2030-03-07');
  assert.equal(q.discount, null);
  assert.equal(q.totalCzk, 17940);
});

test('7: více pravidel → nejvyšší odpovídající práh (16 nocí → 10 %)', async () => {
  await setDiscounts([[21, 15], [7, 5], [14, 10]]);
  const q = await quote('2030-03-01', '2030-03-17');
  assert.equal(q.nights, 16);
  // 16 × 2 990 = 47 840 Kč; 10 % = 4 784 Kč; celkem 43 056 Kč.
  assert.equal(q.subtotalCzk, 47840);
  assert.deepEqual(q.discount, { type: 'length', minNights: 14, percent: 10, amountCzk: 4784 });
  assert.equal(q.totalCzk, 43056);
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
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 100 }], stayPriceCzk: null }).totalCzk, 0);
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 0 }], stayPriceCzk: null }).totalCzk, 999);
  // 3 % z 999 = 29,97 → 29 Kč.
  assert.equal(computeQuote({ arrival: '2030-04-01', departure: '2030-04-02' }, { defaultNightlyPriceCzk: 999, dailyPrices: new Map(), discounts: [{ minNights: 1, percent: 3 }], stayPriceCzk: null }).discount?.amountCzk, 29);
});

test('9: pobyt přes konec měsíce', async () => {
  await setPrices({ '2030-02-01': 4000 });
  const q = await quote('2030-01-30', '2030-02-02');
  assert.deepEqual(q.nightlyPrices.map((n) => n.date), ['2030-01-30', '2030-01-31', '2030-02-01']);
  assert.equal(q.totalCzk, 9980); // 2 × 2 990 + 4 000
});

test('10: pobyt přes konec roku', async () => {
  await setPrices({ '2030-12-31': 6000, '2031-01-01': 5000 });
  const q = await quote('2030-12-30', '2031-01-02');
  assert.deepEqual(q.nightlyPrices, [
    { date: '2030-12-30', priceCzk: 2990 },
    { date: '2030-12-31', priceCzk: 6000 },
    { date: '2031-01-01', priceCzk: 5000 },
  ]);
  assert.equal(q.totalCzk, 13990);
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
    // 10 × 2 990 = 29 900 Kč; 5 % = 1 495 Kč; celkem 28 405 Kč.
    arrivalDate: '2030-12-07', departureDate: '2030-12-17', nights: 10, pricingMode: 'nightly', subtotalCzk: 29900,
    discount: { type: 'length', minNights: 7, percent: 5, amountCzk: 1495 }, totalCzk: 28405, nightlyPrices: 10,
  });
  assert.deepEqual(body.nightlyPrices[0], { date: '2030-12-07', priceCzk: 2990 });
});

test('11: /api/quote odmítne neplatné termíny a počet hostů (422 s názvy polí)', async () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ arrivalDate: '2030-01-09', departureDate: '2030-01-12', guests: 2 }, ['arrivalDate']],
    [{ arrivalDate: '2030-02-05', departureDate: '2030-02-05', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-05', departureDate: '2030-02-01', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-01', departureDate: '2030-03-05', guests: 2 }, ['departureDate']],
    [{ arrivalDate: '2030-02-30', departureDate: '2030-03-02', guests: 2 }, ['arrivalDate']],
    [{ arrivalDate: '2031-01-11', departureDate: '2031-01-13', guests: 2 }, ['arrivalDate']],
    // Minimální délka pobytu (MIN_NIGHTS = 2): 1 noc → chyba odjezdu.
    [{ arrivalDate: '2030-02-01', departureDate: '2030-02-02', guests: 2 }, ['departureDate']],
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
  const corrupt = (prices: unknown[], discounts: unknown[], stays: unknown[] = []) =>
    ({ prepare: () => ({ bind: () => ({}) }), batch: async () => [{ results: stays }, { results: prices }, { results: discounts }] }) as unknown as D1Database;
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
  // 6 × 2 990 + 4 500 + 6 000 = 28 440; 10 % = 2 844 → 25 596 Kč.
  assert.equal(q.totalCzk, 25596);
  const response = await booking().post({ arrival: '2030-02-01', departure: '2030-02-09', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 201);
  assert.equal((await read(response)).reservation.priceCzk, 25596);
  assert.equal((await t.db.prepare('SELECT price_czk FROM reservations').first<{ price_czk: number }>())!.price_czk, 25596);
  // Bez expectedPriceCzk se uloží cena ze serveru (2 × 2 990 Kč).
  const b = await booking().post({ arrival: '2030-03-01', departure: '2030-03-03', ...GUEST });
  assert.equal((await read(b)).reservation.priceCzk, 5980);
});

test('16: změna ceníku mezi nabídkou a rezervací → 409 price-mismatch s novou cenou, nic se nezapíše', async () => {
  const q = await read(await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 }));
  assert.equal(q.totalCzk, 5980);
  await setPrices({ '2030-02-02': 4000 });
  const response = await booking().post({ arrival: '2030-02-01', departure: '2030-02-03', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 409);
  assert.deepEqual(await read(response), { error: 'price-mismatch', priceCzk: 6990 }); // 2 990 + 4 000
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

// Pevná cena celého pobytu (stay_prices, pricingMode "exact-stay")
// Silvestr: 29. 12. → 2. 1. = 4 noci, pevně 29 900 Kč (po nocích by to bylo 4 × 3 000 = 12 000 Kč).

const SILVESTR = { arrivalDate: '2030-12-29', departureDate: '2031-01-02', guests: 2 };

test('exact-stay 1: přesná shoda příjezdu a odjezdu → pevná cena, bez slevy a bez rozpisu nocí', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const response = await post(SILVESTR);
  assert.equal(response.status, 200);
  assert.deepEqual(await read(response), {
    arrivalDate: '2030-12-29',
    departureDate: '2031-01-02',
    nights: 4,
    pricingMode: 'exact-stay',
    subtotalCzk: 29900,
    discount: null,
    totalCzk: 29900,
    nightlyPrices: [],
  });
});

test('exact-stay 2: o den jiný příjezd → pravidlo se ignoruje, běžný výpočet po nocích', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  for (const arrival of ['2030-12-28', '2030-12-30']) {
    const q = await quote(arrival, '2031-01-02');
    assert.equal(q.pricingMode, 'nightly', arrival);
    assert.equal(q.totalCzk, arrival === '2030-12-28' ? 14950 : 8970, arrival); // 5 resp. 3 × 2 990
  }
});

test('exact-stay 3: o den jiný odjezd → pravidlo se ignoruje, běžný výpočet po nocích', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const shorter = await quote('2030-12-29', '2031-01-01');
  assert.equal(shorter.pricingMode, 'nightly');
  assert.equal(shorter.totalCzk, 8970); // 3 × 2 990
  const longer = await quote('2030-12-29', '2031-01-03');
  assert.equal(longer.pricingMode, 'nightly');
  assert.equal(longer.totalCzk, 14950); // 5 × 2 990
});

test('exact-stay 4: přednost před daily_prices (i výchozí cenou)', async () => {
  await setPrices({ '2030-12-30': 9000, '2030-12-31': 12000 });
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const q = await quote('2030-12-29', '2031-01-02');
  assert.equal(q.pricingMode, 'exact-stay');
  assert.equal(q.totalCzk, 29900);
  assert.deepEqual(q.nightlyPrices, []);
  // Bez pravidla by to bylo 2 990 + 9 000 + 12 000 + 2 990 = 26 980 Kč.
  await t.db.prepare('DELETE FROM stay_prices').run();
  assert.equal((await quote('2030-12-29', '2031-01-02')).totalCzk, 26980);
});

test('exact-stay 5: přednost před length_discounts – sleva se na pevnou cenu neuplatní', async () => {
  await setDiscounts([[2, 10], [4, 20]]);
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const q = await quote('2030-12-29', '2031-01-02');
  assert.equal(q.discount, null);
  assert.equal(q.subtotalCzk, 29900);
  assert.equal(q.totalCzk, 29900);
});

test('exact-stay 6: bez pravidla (nebo s pravidlem pro jiný termín) se počítá beze změny po nocích', async () => {
  await setPrices({ '2030-12-31': 6000 });
  await setDiscounts([[4, 10]]);
  await setStayPrice('2030-07-01', '2030-07-08', 50000);
  // 2 990 + 2 990 + 6 000 + 2 990 = 14 970; 10 % = 1 497 → 13 473 Kč.
  assert.deepEqual(await quote('2030-12-29', '2031-01-02'), {
    arrivalDate: '2030-12-29',
    departureDate: '2031-01-02',
    nights: 4,
    pricingMode: 'nightly',
    subtotalCzk: 14970,
    discount: { type: 'length', minNights: 4, percent: 10, amountCzk: 1497 },
    totalCzk: 13473,
    nightlyPrices: [
      { date: '2030-12-29', priceCzk: 2990 },
      { date: '2030-12-30', priceCzk: 2990 },
      { date: '2030-12-31', priceCzk: 6000 },
      { date: '2031-01-01', priceCzk: 2990 },
    ],
  });
});

test('exact-stay 7: změna pevné ceny mezi /api/quote a rezervací → 409 price-mismatch, nic se nezapíše', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const q = await read(await post(SILVESTR));
  assert.equal(q.totalCzk, 29900);
  await setStayPrice('2030-12-29', '2031-01-02', 32900);
  const response = await booking().post({ arrival: '2030-12-29', departure: '2031-01-02', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 409);
  assert.deepEqual(await read(response), { error: 'price-mismatch', priceCzk: 32900 });
  // Smazání pravidla mezi nabídkou a rezervací → zpět na cenu po nocích (4 × 2 990 = 11 960 Kč).
  await t.db.prepare('DELETE FROM stay_prices').run();
  const removed = await booking().post({ arrival: '2030-12-29', departure: '2031-01-02', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(removed.status, 409);
  assert.deepEqual(await read(removed), { error: 'price-mismatch', priceCzk: 11960 });
  assert.equal(await t.count('reservations'), 0);
  assert.equal(await t.sequence(), 0, 'VS se nespotřebuje');
});

test('exact-stay 8: neplatná data ve stay_prices → CHECK je odmítne, a kdyby prošla, 503 pricing-unavailable', async () => {
  for (const values of [
    `('2030-12-29', '2031-01-02', 0)`,
    `('2030-12-29', '2031-01-02', -29900)`,
    `('2030-12-29', '2031-01-02', 29900.5)`,
    `('2030-12-29', '2031-01-02', 'hodně')`,
    `('2030-12-29', '2031-01-02', 30000001)`,
    `('2031-01-02', '2030-12-29', 29900)`,
    `('2030-12-29', '2030-12-29', 29900)`,
    `('2030-02-30', '2030-03-02', 29900)`,
    `('2030-12-29', '2031-13-01', 29900)`,
    `('29.12.2030', '2031-01-02', 29900)`,
  ]) {
    await assert.rejects(t.db.prepare(`INSERT INTO stay_prices (arrival_date, departure_date, total_czk) VALUES ${values}`).run(), /CHECK constraint failed/, values);
  }
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  await assert.rejects(t.db.prepare(`INSERT INTO stay_prices VALUES ('2030-12-29', '2031-01-02', 19900)`).run(), /UNIQUE constraint failed|PRIMARY KEY/);
  assert.equal(await stayCount(), 1);

  const stay = { arrival: '2030-12-29', departure: '2031-01-02' };
  const corrupt = (stays: unknown[]) =>
    ({ prepare: () => ({ bind: () => ({}) }), batch: async () => [{ results: stays }, { results: [] }, { results: [] }] }) as unknown as D1Database;
  const row = { arrival_date: stay.arrival, departure_date: stay.departure };
  for (const db of [
    corrupt([{ ...row, total_czk: 0 }]),
    corrupt([{ ...row, total_czk: '29900' }]),
    corrupt([{ ...row, total_czk: 29900.5 }]),
    corrupt([{ ...row, total_czk: 30_000_001 }]),
    corrupt([{ ...row, total_czk: null }]),
    corrupt([{ ...row, arrival_date: '2030-12-30', total_czk: 29900 }]),
    corrupt([{ ...row, total_czk: 29900 }, { ...row, total_czk: 19900 }]),
  ]) {
    await assert.rejects(loadPricingData(db, stay), PricingDataError);
    const logs: string[] = [];
    const response = await post(SILVESTR, db, logs);
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'pricing-unavailable' });
    assert.deepEqual(logs, ['quote: pricing data invalid']);
  }
  // Platný řádek v téže falešné DB projde – test opravdu kontroluje validaci, ne falešnou DB.
  assert.equal((await loadPricingData(corrupt([{ ...row, total_czk: 29900 }]), stay)).stayPriceCzk, 29900);
});

test('exact-stay 8b: rezervace nad poškozenou tabulkou stay_prices → 503 pricing-unavailable, nic se nezapíše', async () => {
  await t.db.prepare('DROP TABLE stay_prices').run();
  await t.db.prepare('CREATE TABLE stay_prices (arrival_date TEXT, departure_date TEXT, total_czk)').run();
  await t.db.prepare(`INSERT INTO stay_prices VALUES ('2030-12-29', '2031-01-02', 'dohodou')`).run();
  try {
    const b = booking();
    const response = await b.post({ arrival: '2030-12-29', departure: '2031-01-02', ...GUEST });
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'pricing-unavailable' });
    assert.ok(b.logs.includes('reservations: pricing data invalid'));
    assert.equal(await t.count('reservations'), 0);
  } finally {
    await t.db.prepare('DROP TABLE stay_prices').run();
    await t.db
      .prepare(
        `CREATE TABLE stay_prices (arrival_date TEXT NOT NULL CHECK (arrival_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(arrival_date) IS arrival_date), departure_date TEXT NOT NULL CHECK (departure_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(departure_date) IS departure_date), total_czk INTEGER NOT NULL CHECK (typeof(total_czk) = 'integer' AND total_czk > 0 AND total_czk <= 30000000), PRIMARY KEY (arrival_date, departure_date), CHECK (departure_date > arrival_date))`,
      )
      .run();
  }
});

test('exact-stay 9: /api/quote s pevnou cenou nic nezapisuje (jen SELECT)', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const statements: string[] = [];
  const recording = new Proxy(t.db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => (statements.push(sql), target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const state = () =>
    t.db.prepare('SELECT (SELECT count(*) FROM stay_prices) AS sp, (SELECT total_czk FROM stay_prices) AS total, (SELECT count(*) FROM reservations) AS r, (SELECT count(*) FROM reserved_nights) AS n, (SELECT value FROM sequences) AS s').first();
  const before = await state();
  const response = await post(SILVESTR, recording);
  assert.equal((await read(response)).pricingMode, 'exact-stay');
  assert.ok(statements.length > 0 && statements.every((sql) => /^\s*SELECT\b/i.test(sql)), statements.join('\n'));
  assert.deepEqual(await state(), before);
});

test('exact-stay 10: rezervace a /api/quote dávají pro pevnou cenu stejnou částku, uloží se do D1', async () => {
  await setPrices({ '2030-12-31': 6000 });
  await setDiscounts([[4, 10]]);
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const q = await read(await post(SILVESTR));
  assert.equal(q.totalCzk, 29900);
  const response = await booking().post({ arrival: '2030-12-29', departure: '2031-01-02', ...GUEST, expectedPriceCzk: q.totalCzk });
  assert.equal(response.status, 201);
  assert.equal((await read(response)).reservation.priceCzk, 29900);
  assert.equal((await t.db.prepare('SELECT price_czk FROM reservations').first<{ price_czk: number }>())!.price_czk, 29900);
});

test('exact-stay 11: pravidlo nemění dostupnost – nic neblokuje a obsazení části ho neodstraní', async () => {
  await setStayPrice('2030-12-29', '2031-01-02', 29900);
  const range = { from: '2030-12-01', to: '2031-02-01' };
  assert.deepEqual(await listReservedNights(t.db, range), [], 'samotné pravidlo žádnou noc neobsadí');
  // Kratší pobyt uvnitř intervalu pravidla jde rezervovat, za běžnou cenu po nocích.
  const inner = await booking().post({ arrival: '2030-12-30', departure: '2031-01-01', ...GUEST, expectedPriceCzk: 5980 });
  assert.equal(inner.status, 201);
  assert.equal((await read(inner)).reservation.priceCzk, 5980); // 2 × 2 990
  // Pravidlo zůstává uložené a cenu dál vrací (nabídka dostupnost neověřuje)…
  assert.equal(await stayCount(), 1);
  assert.equal((await quote('2030-12-29', '2031-01-02')).totalCzk, 29900);
  // …ale celý interval už přirozeně rezervovat nejde.
  const whole = await booking().post({ arrival: '2030-12-29', departure: '2031-01-02', ...GUEST, expectedPriceCzk: 29900 });
  assert.equal(whole.status, 409);
  assert.deepEqual(await read(whole), { error: 'dates-unavailable' });
  assert.equal(await t.count('reservations'), 1);
});

test('minimální délka pobytu: /api/quote 2 noci → 200, 1 noc → 422 departureDate', async () => {
  const two = await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-03', guests: 2 });
  assert.equal(two.status, 200);
  assert.deepEqual({ nights: (await read(two)).nights }, { nights: 2 });
  const one = await post({ arrivalDate: '2030-02-01', departureDate: '2030-02-02', guests: 2 });
  assert.equal(one.status, 422);
  assert.deepEqual(await read(one), { error: 'invalid-request', fields: ['departureDate'] });
});

test('minimální délka pobytu: exact-stay cena na 1 noc pravidlo neobejde (quote ani rezervace)', async () => {
  await setStayPrice('2030-12-31', '2031-01-01', 9900);
  const q = await post({ arrivalDate: '2030-12-31', departureDate: '2031-01-01', guests: 2 });
  assert.equal(q.status, 422);
  assert.deepEqual(await read(q), { error: 'invalid-request', fields: ['departureDate'] });
  const r = await booking().post({ arrival: '2030-12-31', departure: '2031-01-01', ...GUEST, expectedPriceCzk: 9900 });
  assert.equal(r.status, 422);
  assert.deepEqual(await read(r), { error: 'invalid-request', fields: ['departure'] });
  assert.equal(await t.count('reservations'), 0);
  // Pravidlo samo zůstává jen cenou – dvounocní pobyt kolem něj se počítá běžně (2 × 2 990 Kč).
  assert.equal((await read(await post({ arrivalDate: '2030-12-30', departureDate: '2031-01-01', guests: 2 }))).totalCzk, 5980);
});
