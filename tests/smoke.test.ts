import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.ts';
import { resetAvailabilityMemory } from '../worker/availability.ts';
import { formatSmoke, parseBaseUrl, runSmoke, type SmokeCheck } from '../scripts/lib/smoke.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Smoke test veřejných endpointů proti skutečnému Workeru (worker/index.ts) s produkční
// a preview konfigurací. Export e-chalup je falešný; jen smyšlené údaje.
const BASE = parseBaseUrl('https://chalupa.test.invalid');
const EXPORT_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const EXPORT_TOKEN = 'exportni-token-0123456789abcdef0123456789';

let t: Awaited<ReturnType<typeof createTestDatabase>>;
const realFetch = globalThis.fetch;
before(async () => {
  t = await createTestDatabase('production');
  // Worker stahuje export e-chalup globálním fetch – v testu vrací fixture.
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input) === EXPORT_URL ? new Response(fixture('01-single-and-multi.ics')) : new Response('neočekávaný požadavek', { status: 599 })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  return t.dispose();
});
beforeEach(() => resetAvailabilityMemory());

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const PRODUCTION: Partial<WorkerEnv> = {
  BOOKING_ENV: 'production',
  BOOKING_ICAL_EXPORT_ENABLED: 'true',
  BOOKING_ICAL_EXPORT_TOKEN: EXPORT_TOKEN,
  ECHALUPY_ICAL_URL: EXPORT_URL,
};
const PREVIEW: Partial<WorkerEnv> = {
  ...PRODUCTION,
  BOOKING_ENV: 'preview',
  BOOKING_API_ENABLED: 'true',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_SITE_KEY: '1x00000000000000000000BB',
  BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function workerFetch(env: Partial<WorkerEnv>) {
  const requests: Request[] = [];
  const fullEnv = {
    DB: t.db,
    ASSETS: { fetch: async () => new Response('<!doctype html><title>Chalupa Všetice</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    ...env,
  } as unknown as WorkerEnv;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone() as Request);
    return worker.fetch!(request as Parameters<typeof worker.fetch>[0], fullEnv, ctx);
  }) as typeof fetch;
  return { fetchFn, requests };
}

const byName = (checks: SmokeCheck[], fragment: string) => {
  const check = checks.find((c) => c.name.includes(fragment));
  assert.ok(check, fragment);
  return check;
};

test('produkce: všechny kontroly projdou, rezervační POST je vypnutý (404)', async () => {
  const { fetchFn } = workerFetch(PRODUCTION);
  const checks = await runSmoke(BASE, 'production', fetchFn);
  assert.deepEqual(checks.filter((c) => !c.ok), [], formatSmoke(checks).text);
  assert.equal(checks.length, 9);
  assert.equal(byName(checks, '/api/booking-config').detail, 'bookingEnabled false');
  assert.equal(byName(checks, 'POST /api/reservations').detail, 'vypnutý');
  assert.match(byName(checks, 'POST /api/quote – cenová').detail!, /: 5980 Kč \(nightly\)$/);
  assert.equal(formatSmoke(checks).ok, true);
});

test('smoke test nepoužívá tokeny, Authorization ani cookies a nic nezapíše', async () => {
  const { fetchFn, requests } = workerFetch(PREVIEW);
  await runSmoke(BASE, 'preview', fetchFn);
  assert.ok(requests.length >= 8);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, BASE.origin);
    assert.equal(url.search, '', request.url);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('cookie'), null);
  }
  assert.equal(await t.count('reservations'), 0);
});

test('produkce se zapnutým rezervačním POST → smoke test selže', async () => {
  const { fetchFn } = workerFetch({ ...PREVIEW, BOOKING_ENV: 'production' });
  const checks = await runSmoke(BASE, 'production', fetchFn);
  const reservation = byName(checks, 'POST /api/reservations');
  assert.equal(reservation.ok, false);
  assert.match(reservation.detail!, /je v produkci zapnutý/);
  assert.equal(formatSmoke(checks).ok, false);
});

test('preview: zapnutý POST odmítne prázdný požadavek (422), ostatní kontroly projdou', async () => {
  const { fetchFn } = workerFetch(PREVIEW);
  const checks = await runSmoke(BASE, 'preview', fetchFn);
  assert.deepEqual(checks.filter((c) => !c.ok), [], formatSmoke(checks).text);
  assert.equal(byName(checks, 'POST /api/reservations').detail, 'HTTP 422 invalid-request');
  // S Bearer tokenem v Preview: 401 je také v pořádku (smoke test token nezná ani nepotřebuje).
  const withToken = workerFetch({ ...PREVIEW, BOOKING_API_TOKEN: 'preview-token-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(byName(await runSmoke(BASE, 'preview', withToken.fetchFn), 'POST /api/reservations').detail, 'HTTP 401 unauthorized');
});

test('výpadek D1 (např. chybějící migrace ceníku) → kontrola /api/quote selže', async () => {
  const { fetchFn } = workerFetch({ ...PRODUCTION, DB: failingDatabase(t.db, 'batch') });
  const checks = await runSmoke(BASE, 'production', fetchFn);
  const quote = byName(checks, 'POST /api/quote – cenová');
  assert.equal(quote.ok, false);
  assert.equal(quote.detail, 'HTTP 503 database-error');
});

test('obsazenost: unavailable → selže; stale → varování bez selhání', async () => {
  const { fetchFn } = workerFetch({ ...PRODUCTION, ECHALUPY_ICAL_URL: undefined });
  const unavailable = byName(await runSmoke(BASE, 'production', fetchFn), '/api/availability');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.detail, 'status unavailable');

  const stale = async () => Response.json({ status: 'stale', busy: [], updatedAt: null, checkedAt: '2026-10-08T10:00:00Z', range: { from: '2026-10-08', to: '2027-11-01' } }, { headers: { 'x-content-type-options': 'nosniff' } });
  const check = byName(await runSmoke(BASE, 'production', fakeSite({ '/api/availability': stale })), '/api/availability');
  assert.deepEqual([check.ok, check.warning], [true, true]);
  assert.match(formatSmoke([check]).text, /^! GET \/api\/availability/);
});

/** Falešný web: zadané cesty přepíší odpovědi skutečného produkčního Workeru. */
function fakeSite(overrides: Record<string, () => Promise<Response>>) {
  const { fetchFn } = workerFetch(PRODUCTION);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    return overrides[path] ? overrides[path]() : fetchFn(input, init);
  }) as typeof fetch;
}

test('odhalí únik osobních údajů, přijatou rezervaci, veřejný export a chybějící hlavičky', async () => {
  const leak = await runSmoke(
    BASE,
    'production',
    fakeSite({ '/api/availability': async () => Response.json({ status: 'ok', busy: [{ start: '2026-11-01', end: '2026-11-03', email: 'host@example.invalid' }] }, { headers: { 'x-content-type-options': 'nosniff' } }) }),
  );
  assert.equal(byName(leak, '/api/availability').detail, 'odpověď obsahuje osobní údaje');

  const accepted = await runSmoke(BASE, 'preview', fakeSite({ '/api/reservations': async () => Response.json({ reservation: {} }, { status: 201 }) }));
  assert.match(byName(accepted, 'POST /api/reservations').detail!, /přijal prázdný požadavek/);

  const publicIcs = await runSmoke(BASE, 'production', fakeSite({ '/api/reservations.ics': async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n') }));
  assert.equal(byName(publicIcs, 'reservations.ics').ok, false);

  const noHeaders = await runSmoke(BASE, 'production', fakeSite({ '/api/neexistuje': async () => new Response('{"error":"not-found"}', { status: 404 }) }));
  assert.equal(byName(noHeaders, '/api/neexistuje').ok, false);

  const network = await runSmoke(BASE, 'production', (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch);
  assert.ok(network.every((c) => !c.ok && c.detail === 'fetch failed'));
});

test('základní URL: jen origin přes https (http jen localhost), bez tokenu a přihlašovacích údajů', () => {
  assert.equal(parseBaseUrl('https://chalupavsetice.cz').origin, 'https://chalupavsetice.cz');
  assert.equal(parseBaseUrl('https://chalupavsetice.cz/').origin, 'https://chalupavsetice.cz');
  assert.equal(parseBaseUrl('http://localhost:8787').origin, 'http://localhost:8787');
  for (const [input, expected] of [
    ['https://chalupavsetice.cz/api/reservations.ics?token=tajne', /jen origin/],
    ['https://chalupavsetice.cz/?token=tajne', /jen origin/],
    ['https://chalupavsetice.cz/#x', /jen origin/],
    ['https://uzivatel:heslo@chalupavsetice.cz', /přihlašovací údaje/],
    ['http://chalupavsetice.cz', /https/],
    ['ftp://chalupavsetice.cz', /https/],
    ['chalupavsetice.cz', /neplatná URL/],
  ] as const) {
    assert.throws(() => parseBaseUrl(input), expected, input);
  }
});
