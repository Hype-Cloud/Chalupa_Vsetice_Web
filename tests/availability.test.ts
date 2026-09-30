import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_MS, getAvailability, MAX_EXPORT_BYTES, resetAvailabilityMemory, RETRY_AFTER_FAILURE_MS, STALE_MAX_MS, type AvailabilityDeps, type SnapshotCache } from '../worker/availability.ts';
import { fixture } from './helpers.ts';
import { occupancyFromResponse } from '../lib/availability/occupancy.ts';
import { EMPTY_STAY, pickDay, setArrival } from '../lib/availability/stay.ts';

// Smyšlená adresa s „tokenem“ – ověřuje, že se nikam nepropíše.
const SECRET_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const env = { ECHALUPY_ICAL_URL: SECRET_URL };
const START = new Date('2030-01-10T10:00:00Z');

type Upstream = () => Promise<Response>;

function setup(upstream: Upstream) {
  let now = START;
  const logs: string[] = [];
  const requests: { url: string; method: string; userAgent: string | null }[] = [];
  const store = new Map<string, string>();
  const cache: SnapshotCache = {
    async match(key) {
      const body = store.get(key);
      return body === undefined ? undefined : new Response(body);
    },
    async put(key, response) {
      store.set(key, await response.text());
    },
  };
  const pending: Promise<unknown>[] = [];
  const deps: AvailabilityDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', userAgent: new Headers(init?.headers).get('user-agent') });
      return upstream();
    }) as typeof fetch,
    now: () => now,
    cache,
    defer: (promise) => pending.push(promise),
    log: (message) => logs.push(message),
  };
  return {
    deps,
    logs,
    requests,
    store,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    flush: () => Promise.all(pending),
    call: () => getAvailability(env, deps),
  };
}

const ics = (name: string): Upstream => async () => new Response(fixture(name), { status: 200, headers: { 'content-type': 'text/calendar' } });

beforeEach(() => resetAvailabilityMemory());

test('úspěšné načtení vrátí status ok, intervaly a čas synchronizace', async () => {
  const t = setup(ics('01-single-and-multi.ics'));
  const result = await t.call();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.busy, [
    { start: '2030-01-15', end: '2030-01-16' },
    { start: '2030-01-20', end: '2030-01-25' },
  ]);
  assert.equal(result.updatedAt, START.toISOString());
  assert.deepEqual(result.range, { from: '2030-01-09', to: '2031-02-14' });
});

test('export se načítá výhradně metodou GET a cache brání opakovanému stahování', async () => {
  const t = setup(ics('01-single-and-multi.ics'));
  await t.call();
  t.advance(FRESH_MS - 1000);
  await t.call();
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0].method, 'GET');
});

test('7: neplatný iCal nikdy nevrátí prázdný kalendář', async () => {
  const t = setup(ics('07-invalid-html.ics'));
  const result = await t.call();
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.busy, []);
  assert.equal(result.updatedAt, null);
  assert.deepEqual(t.logs, ['availability: upstream failed (invalid-ical)']);
});

test('8: nedostupný server (HTTP 503 i síťová chyba) → unavailable', async () => {
  const down = setup(async () => new Response('down', { status: 503 }));
  assert.equal((await down.call()).status, 'unavailable');
  resetAvailabilityMemory();
  const offline = setup(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await offline.call()).status, 'unavailable');
  assert.deepEqual(offline.logs, ['availability: upstream failed (network)']);
});

test('8: při výpadku se použijí poslední data jako stale, po 24 h už ne', async () => {
  let healthy = true;
  const t = setup(async () => (healthy ? new Response(fixture('01-single-and-multi.ics')) : new Response('down', { status: 500 })));
  await t.call();
  await t.flush();
  healthy = false;
  t.advance(FRESH_MS + 1000);
  const stale = await t.call();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.busy.length, 2);
  assert.equal(stale.updatedAt, START.toISOString());
  t.advance(STALE_MAX_MS);
  assert.equal((await t.call()).status, 'unavailable');
});

test('8: po selhání se export nestahuje znovu dřív než za minutu', async () => {
  const t = setup(async () => new Response('down', { status: 503 }));
  await t.call();
  t.advance(RETRY_AFTER_FAILURE_MS - 1000);
  await t.call();
  assert.equal(t.requests.length, 1);
  t.advance(2000);
  await t.call();
  assert.equal(t.requests.length, 2);
});

test('9: nová obsazenost se projeví po vypršení cache', async () => {
  let version = '09-sync-before.ics';
  const t = setup(async () => new Response(fixture(version)));
  assert.equal((await t.call()).busy.length, 1);
  version = '09-sync-after.ics';
  t.advance(FRESH_MS / 2);
  assert.equal((await t.call()).busy.length, 1, 'v rámci platnosti cache se export nestahuje');
  t.advance(FRESH_MS);
  const updated = await t.call();
  assert.deepEqual(updated.busy, [
    { start: '2030-01-15', end: '2030-01-18' },
    { start: '2030-01-26', end: '2030-01-29' },
  ]);
});

test('sdílená cache (Cache API) přežije restart izolátu', async () => {
  const t = setup(ics('01-single-and-multi.ics'));
  await t.call();
  await t.flush();
  assert.equal(t.store.size, 1);
  resetAvailabilityMemory();
  t.advance(60_000);
  assert.equal((await t.call()).status, 'ok');
  assert.equal(t.requests.length, 1);
});

test('chybějící secret → unavailable bez pokusu o stažení', async () => {
  const t = setup(ics('01-single-and-multi.ics'));
  const result = await getAvailability({}, t.deps);
  assert.equal(result.status, 'unavailable');
  assert.equal(t.requests.length, 0);
});

test('secret se neobjeví v odpovědi, cache ani v logu', async () => {
  const ok = setup(ics('01-single-and-multi.ics'));
  const okResult = await ok.call();
  await ok.flush();
  resetAvailabilityMemory();
  const failing = setup(async () => new Response('Unauthorized', { status: 401 }));
  const failResult = await failing.call();
  const everything = JSON.stringify([okResult, failResult, [...ok.store.entries()], ok.logs, failing.logs]);
  assert.ok(!everything.includes('SECRET-TOKEN-123'));
  assert.ok(!everything.includes('ical.test.invalid'));
  assert.equal(ok.requests[0].url, SECRET_URL, 'secret se použije jen jako cíl GET požadavku');
});

test('diagnostika: důvod nedostupnosti v odpovědi bez citlivých údajů', async () => {
  const notFound = setup(async () => new Response('Not found', { status: 404 }));
  const result = await notFound.call();
  assert.equal(result.reason, 'upstream-http-404');
  notFound.advance(10_000);
  assert.equal((await notFound.call()).reason, 'upstream-http-404', 'během backoffu zůstává poslední důvod');
  resetAvailabilityMemory();
  assert.equal((await setup(ics('07-invalid-html.ics')).call()).reason, 'upstream-invalid-ical');
  resetAvailabilityMemory();
  assert.equal((await getAvailability({}, setup(ics('14-empty.ics')).deps)).reason, 'not-configured');
  resetAvailabilityMemory();
  const ok = await setup(ics('01-single-and-multi.ics')).call();
  assert.equal(ok.reason, undefined);
});

test('požadavek na export má User-Agent webu', async () => {
  const t = setup(ics('01-single-and-multi.ics'));
  await t.call();
  assert.match(t.requests[0].userAgent ?? '', /^ChalupaVsetice-Availability\//);
});

test('regrese 2.–4. 10. 2026: API vrátí rezervaci z exportu ve formátu e-chalup', async () => {
  const t = setup(ics('15-echalupy-timed.ics'));
  t.deps.now = () => new Date('2026-09-29T20:00:00Z');
  const result = await t.call();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.busy[0], { start: '2026-10-02', end: '2026-10-04' });
  assert.equal(result.busy.length, 3);
  assert.deepEqual(result.source, { events: 3, skipped: 0 });
});

test('neúplný export (vynechané události) se nevydává za kompletní obsazenost', async () => {
  const t = setup(ics('19-invalid-events.ics'));
  const result = await t.call();
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'skipped-events');
  assert.deepEqual(result.source, { events: 4, skipped: 3 });
  assert.equal(result.busy.length, 2);
  assert.ok(t.logs.some((m) => m === 'availability: 3 of 4 events could not be parsed reliably'));
});

test('po nasazení se nepoužije starý snapshot v1 bez diagnostických polí', async () => {
  const t = setup(ics('15-echalupy-timed.ics'));
  t.deps.now = () => new Date('2026-09-29T20:00:00Z');
  // Čerstvý snapshot ve starém formátu (bez events/skipped) pod původním klíčem v1.
  t.store.set('https://availability.cache.internal/v1/snapshot', JSON.stringify({ busy: [], updatedAt: '2026-09-29T19:59:00.000Z', range: { from: '2026-09-28', to: '2027-11-03' } }));
  const result = await t.call();
  assert.equal(t.requests.length, 1, 'starý snapshot se ignoruje a export se stáhne znovu');
  assert.deepEqual(result.source, { events: 3, skipped: 0 });
  assert.deepEqual(result.busy[0], { start: '2026-10-02', end: '2026-10-04' });
});

test('neúplný export → výpadek e-chalup → záložní neúplný snapshot: výběr pobytu zůstává zablokovaný', async () => {
  let healthy = true;
  const t = setup(async () => (healthy ? new Response(fixture('19-invalid-events.ics')) : new Response('down', { status: 500 })));
  const first = await t.call();
  assert.equal(first.status, 'partial');
  assert.equal(first.incomplete, true);
  await t.flush();

  healthy = false;
  t.advance(FRESH_MS + 1000);
  const fallback = await t.call();
  assert.equal(fallback.status, 'stale');
  assert.equal(fallback.reason, 'upstream-http-500');
  assert.equal(fallback.incomplete, true, 'příznak neúplnosti se nesmí ztratit ve stale fallbacku');
  assert.deepEqual(fallback.source, { events: 4, skipped: 3 });

  // Klient: známé obsazené noci zůstávají, ostatní dny nejsou volné a výběr je zablokovaný.
  const occupancy = occupancyFromResponse(fallback)!;
  const ctx = { today: '2030-01-10', occupancy };
  assert.equal(occupancy.night('2030-03-01'), 'busy');
  assert.equal(occupancy.night('2030-02-01'), 'unknown');
  assert.equal(pickDay(EMPTY_STAY, '2030-02-01', ctx).error, 'unknown');
  assert.equal(setArrival(EMPTY_STAY, '2030-02-01', ctx).error, 'unknown');
});

test('stale fallback z úplného snapshotu zůstává použitelný (incomplete: false)', async () => {
  let healthy = true;
  const t = setup(async () => (healthy ? new Response(fixture('01-single-and-multi.ics')) : new Response('down', { status: 500 })));
  assert.equal((await t.call()).incomplete, false);
  await t.flush();
  healthy = false;
  t.advance(FRESH_MS + 1000);
  const fallback = await t.call();
  assert.equal(fallback.status, 'stale');
  assert.equal(fallback.incomplete, false);
  const ctx = { today: '2030-01-10', occupancy: occupancyFromResponse(fallback) };
  assert.equal(pickDay(EMPTY_STAY, '2030-02-01', ctx).error, null);
});

/** Tělo odpovědi po částech a bez Content-Length (hlavička může chybět nebo lhát). */
function streamed(text: string, chunk = 64 * 1024, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, (offset += chunk)));
    },
  });
  return new Response(body, { headers });
}

const bigExport = (bytes: number) =>
  fixture('01-single-and-multi.ics').replace('END:VCALENDAR', `X-PADDING:${'x'.repeat(bytes)}\r\nEND:VCALENDAR`);

test('limit velikosti: počítají se skutečně přijaté bajty, ne Content-Length', async () => {
  const t = setup(async () => streamed(bigExport(MAX_EXPORT_BYTES), 64 * 1024, { 'content-length': '100' }));
  const result = await t.call();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'upstream-too-large');
  assert.deepEqual(result.busy, []);
});

test('limit velikosti: Content-Length nad limitem se odmítne hned', async () => {
  const t = setup(async () => new Response('BEGIN:VCALENDAR', { headers: { 'content-length': String(MAX_EXPORT_BYTES + 1) } }));
  assert.equal((await t.call()).reason, 'upstream-too-large');
});

test('limit velikosti: export pod limitem po částech projde', async () => {
  const t = setup(async () => streamed(bigExport(MAX_EXPORT_BYTES - 10_000), 7_777));
  const result = await t.call();
  assert.equal(result.status, 'ok');
  assert.equal(result.busy.length, 2);
});

test('limit velikosti: při výpadku zůstanou poslední platná data (stale), nikdy falešné volno', async () => {
  let big = false;
  const t = setup(async () => (big ? streamed(bigExport(MAX_EXPORT_BYTES)) : new Response(fixture('01-single-and-multi.ics'))));
  await t.call();
  await t.flush();
  big = true;
  t.advance(FRESH_MS + 1000);
  const result = await t.call();
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'upstream-too-large');
  assert.equal(result.busy.length, 2);
});
