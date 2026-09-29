import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_MS, getAvailability, resetAvailabilityMemory, RETRY_AFTER_FAILURE_MS, STALE_MAX_MS, type AvailabilityDeps, type SnapshotCache } from '../worker/availability.ts';
import { fixture } from './helpers.ts';

// Smyšlená adresa s „tokenem“ – ověřuje, že se nikam nepropíše.
const SECRET_URL = 'https://ical.test.invalid/api/calendar/0/SECRET-TOKEN-123/default.ics';
const env = { ECHALUPY_ICAL_URL: SECRET_URL };
const START = new Date('2030-01-10T10:00:00Z');

type Upstream = () => Promise<Response>;

function setup(upstream: Upstream) {
  let now = START;
  const logs: string[] = [];
  const requests: { url: string; method: string }[] = [];
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
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
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
