import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { createTestDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Veřejný POST /api/reservations: Turnstile, rate limit, idempotence a chybové kódy.
// Jen smyšlené údaje; Siteverify i export e-chalup jsou falešné.
const EXPORT_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const TURNSTILE_SECRET = 'turnstile-secret-PRIVATE-789';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const IP = '203.0.113.7';
const GUEST = { firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid' };

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(() => t.reset());

type Siteverify = (body: Record<string, string>) => Response | Promise<Response>;

function setup(options: { siteverify?: Siteverify; limiter?: (key: string) => Promise<{ success: boolean }>; exportResponse?: () => Response; env?: Partial<BookingEnv> } = {}) {
  const logs: string[] = [];
  const verifications: Record<string, string>[] = [];
  const limiterKeys: string[] = [];
  let exportFetches = 0;
  let uuid = 0;
  const siteverify = options.siteverify ?? (() => Response.json({ success: true }));
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: EXPORT_URL, DB: t.db, BOOKING_ENV: 'preview', BOOKING_API_ENABLED: 'true', TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    BOOKING_RATE_LIMITER: { limit: ({ key }) => (limiterKeys.push(key), options.limiter ? options.limiter(key) : Promise.resolve({ success: true })) },
    ...options.env,
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === SITEVERIFY_URL) {
      const body = JSON.parse(String(init?.body));
      verifications.push(body);
      return siteverify(body);
    }
    exportFetches++;
    return options.exportResponse ? options.exportResponse() : new Response(fixture('01-single-and-multi.ics'));
  }) as typeof fetch;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleCreateReservation(
      new Request('https://preview.test.invalid/api/reservations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP, ...headers },
        body: JSON.stringify(body),
      }),
      env,
      { fetch: fetchFn, now: () => new Date('2030-01-10T10:00:00Z'), randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, log: (m) => logs.push(m) },
    );
  return { env, logs, verifications, limiterKeys, post, exports: () => exportFetches };
}

const stay = (extra: Record<string, unknown> = {}) => ({ arrival: '2030-02-01', departure: '2030-02-04', guests: 2, ...GUEST, turnstileToken: TOKEN, ...extra });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (r: Response): Promise<any> => r.json();

test('Turnstile platný: rezervace vznikne, Siteverify dostane secret, token a IP', async () => {
  const s = setup();
  const response = await s.post(stay());
  assert.equal(response.status, 201);
  assert.equal(s.verifications.length, 1);
  assert.deepEqual(s.verifications[0], { secret: TURNSTILE_SECRET, response: TOKEN, remoteip: IP });
  assert.equal(await t.count('reservations'), 1);
});

test('Turnstile neplatný: 403 turnstile-failed, nic se nestáhne ani nezapíše', async () => {
  const s = setup({ siteverify: () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) });
  const response = await s.post(stay());
  assert.equal(response.status, 403);
  assert.deepEqual(await read(response), { error: 'turnstile-failed' });
  assert.equal(s.exports(), 0);
  assert.equal(await t.count('reservations'), 0);
  assert.ok(s.logs.includes('reservations: turnstile rejected (invalid-input-response)'));
});

test('Turnstile chybí nebo je moc dlouhý: 400 turnstile-required bez volání Siteverify', async () => {
  const s = setup();
  for (const turnstileToken of [undefined, '', 42, 'x'.repeat(2049)]) {
    const response = await s.post(stay({ turnstileToken }));
    assert.equal(response.status, 400, String(turnstileToken).slice(0, 10));
    assert.deepEqual(await read(response), { error: 'turnstile-required' });
  }
  assert.equal(s.verifications.length, 0);
  assert.equal(await t.count('reservations'), 0);
});

test('Turnstile nedostupný (HTTP chyba, síť, nečitelná odpověď, internal-error, chybný secret): 503, fail-closed', async () => {
  const failures: Siteverify[] = [
    () => new Response('down', { status: 502 }),
    () => Promise.reject(new TypeError('fetch failed')),
    () => new Response('<html>', { status: 200 }),
    () => Response.json({ success: false, 'error-codes': ['internal-error'] }),
    () => Response.json({ success: false, 'error-codes': ['invalid-input-secret'] }),
  ];
  for (const siteverify of failures) {
    const s = setup({ siteverify });
    const response = await s.post(stay());
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'turnstile-unavailable' });
    assert.equal(s.exports(), 0);
  }
  assert.equal(await t.count('reservations'), 0);
});

test('produkce: testovací Turnstile secret nebo chybějící secret/limiter → 503 not-configured', async () => {
  for (const env of [
    { BOOKING_ENV: 'production', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    { TURNSTILE_SECRET_KEY: undefined },
    { BOOKING_RATE_LIMITER: undefined },
  ] as Partial<BookingEnv>[]) {
    const s = setup({ env });
    const response = await s.post(stay());
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'not-configured' });
    assert.equal(s.verifications.length, 0);
  }
});

test('produkce: nesoulad prostředí D1 → 503 bez ověření Turnstile a bez zápisu', async () => {
  const s = setup({ env: { BOOKING_ENV: 'production' } });
  const response = await s.post(stay());
  assert.equal(response.status, 503);
  assert.deepEqual(await read(response), { error: 'database-environment-mismatch' });
  assert.equal(s.verifications.length, 0);
  assert.equal(await t.count('reservations'), 0);
});

test('rate limit povolí: klíč podle IP, rezervace projde', async () => {
  const s = setup();
  assert.equal((await s.post(stay())).status, 201);
  assert.deepEqual(s.limiterKeys, [`reservations:${IP}`]);
});

test('rate limit odmítne: 429 rate-limited s Retry-After, bez Turnstile, exportu i zápisu', async () => {
  const s = setup({ limiter: async () => ({ success: false }) });
  const response = await s.post(stay());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await read(response), { error: 'rate-limited' });
  assert.equal(s.verifications.length, 0);
  assert.equal(s.exports(), 0);
  assert.equal(await t.count('reservations'), 0);
});

test('rate limiter selže: 503 service-unavailable (fail-closed)', async () => {
  const s = setup({ limiter: () => Promise.reject(new Error('limiter down')) });
  const response = await s.post(stay());
  assert.equal(response.status, 503);
  assert.deepEqual(await read(response), { error: 'service-unavailable' });
});

test('idempotentní retry (timeout klienta): stejný klíč i token → původní rezervace bez nového ověření Turnstile', async () => {
  // Skutečné Siteverify by jednorázový token podruhé odmítlo (timeout-or-duplicate).
  let used = false;
  const s = setup({ siteverify: () => Response.json(used ? { success: false, 'error-codes': ['timeout-or-duplicate'] } : ((used = true), { success: true })) });
  const headers = { 'idempotency-key': 'formular-0000000000000001' };
  const first = await read(await s.post(stay(), headers));
  const retry = await s.post(stay(), headers);
  assert.equal(retry.status, 200);
  const body = await read(retry);
  assert.equal(body.replayed, true);
  assert.equal(body.reservation.code, first.reservation.code);
  assert.equal(s.verifications.length, 1);
  assert.equal(await t.count('reservations'), 1);
});

test('dvojklik se stejným klíčem: souběžně jedna rezervace, obě odpovědi ji vrátí', async () => {
  // Siteverify s idempotency_key smí stejný token ověřit znovu.
  const seen = new Set<string>();
  const s = setup({
    siteverify: (body) => {
      const ok = !seen.has(body.response) || !!body.idempotency_key;
      seen.add(body.response);
      return Response.json(ok ? { success: true } : { success: false, 'error-codes': ['timeout-or-duplicate'] });
    },
  });
  const headers = { 'idempotency-key': 'formular-0000000000000002' };
  const [a, b] = await Promise.all([s.post(stay(), headers), s.post(stay(), headers)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const codes = new Set([(await read(a)).reservation.code, (await read(b)).reservation.code]);
  assert.equal(codes.size, 1);
  assert.equal(await t.count('reservations'), 1);
  assert.ok(s.verifications.every((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(v.idempotency_key)));
  assert.equal(new Set(s.verifications.map((v) => v.idempotency_key)).size, 1, 'deterministický idempotency_key');
});

test('dvojklik bez klíče: druhý požadavek neprojde, rezervace je jen jedna', async () => {
  const seen = new Set<string>();
  const s = setup({ siteverify: (body) => Response.json(seen.has(body.response) ? { success: false, 'error-codes': ['timeout-or-duplicate'] } : (seen.add(body.response), { success: true })) });
  const [a, b] = await Promise.all([s.post(stay()), s.post(stay())]);
  assert.deepEqual([a.status, b.status].sort(), [201, 403]);
  assert.equal(await t.count('reservations'), 1);
});

test('obsazený termín: 409 dates-unavailable (export e-chalup i vlastní D1)', async () => {
  const s = setup();
  const external = await s.post(stay({ arrival: '2030-01-14', departure: '2030-01-16' }));
  assert.equal(external.status, 409);
  assert.deepEqual(await read(external), { error: 'dates-unavailable' });
  assert.equal((await s.post(stay())).status, 201);
  const own = await s.post(stay({ arrival: '2030-02-02', departure: '2030-02-04' }));
  assert.equal(own.status, 409);
  assert.deepEqual(await read(own), { error: 'dates-unavailable' });
});

test('výpadek e-chalup: 503 availability-check-failed, nic se nezapíše', async () => {
  const s = setup({ exportResponse: () => new Response('down', { status: 503 }) });
  const response = await s.post(stay());
  assert.equal(response.status, 503);
  assert.deepEqual(await read(response), { error: 'availability-check-failed' });
  assert.equal(await t.count('reservations'), 0);
});

test('neočekávaná chyba: 500 internal-error bez detailů', async () => {
  const s = setup();
  const response = await handleCreateReservation(
    new Request('https://preview.test.invalid/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stay()) }),
    s.env,
    { fetch, now: () => { throw new Error('boom SECRET-TOKEN-123'); }, randomUUID: () => 'x', log: (m) => s.logs.push(m) },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await read(response), { error: 'internal-error' });
  assert.ok(s.logs.includes('reservations: internal error'));
});

test('žádné osobní údaje, tokeny, secrets ani URL exportu v logách a chybových odpovědích', async () => {
  const scenarios = [
    setup({ siteverify: () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) }),
    setup({ siteverify: () => Promise.reject(new TypeError(`fetch failed ${TURNSTILE_SECRET}`)) }),
    setup({ limiter: async () => ({ success: false }) }),
    setup({ exportResponse: () => new Response('down', { status: 500 }) }),
    setup({ env: { BOOKING_ENV: 'production' } }),
  ];
  let everything = '';
  for (const s of scenarios) {
    const response = await s.post(stay(), { 'idempotency-key': 'formular-0000000000000003' });
    everything += (await response.text()) + s.logs.join('\n');
  }
  const ok = setup();
  everything += await (await ok.post(stay({ arrival: '2030-03-01', departure: '2030-03-03' }))).text();
  everything += ok.logs.join('\n');
  for (const secret of ['Testovací', 'test@example.invalid', '000 000', TOKEN, TURNSTILE_SECRET, 'SECRET-TOKEN-123', 'ical.test.invalid', IP, 'formular-0000000000000003']) {
    assert.ok(!everything.includes(secret), secret);
  }
});
