import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvisibleTurnstile, TURNSTILE_ACTION, TurnstileError, type TurnstileApi } from '../components/booking/invisibleTurnstile.ts';

// Invisible Turnstile na klientu: widget připravený předem (execution: execute, bez spuštění),
// po kliknutí jen execute; každý widget vydá nejvýš jeden token a pak se nahradí čerstvým,
// žádné automatické obnovování, pozdní callbacky se ignorují.

type Options = Record<string, unknown> & {
  callback: (token: unknown) => void;
  'error-callback': () => unknown;
  'timeout-callback': () => void;
  'expired-callback': () => void;
};

function fakeApi() {
  const rendered: { id: string; options: Options }[] = [];
  const removed: string[] = [];
  const executed: unknown[] = [];
  let loads = 0;
  const api: TurnstileApi = {
    render: (_el, options) => {
      const id = `w${rendered.length + 1}`;
      rendered.push({ id, options: options as Options });
      return id;
    },
    execute: (el) => void executed.push(el),
    remove: (id) => void removed.push(id),
  };
  const widget = (id: string) => rendered.find((r) => r.id === id)!.options;
  return { api, rendered, removed, executed, widget, load: async () => (loads++, api), loads: () => loads };
}

function fakeTimers() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (fn: () => void) => (timers.set(++next, fn), next),
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    fire: () => [...timers.values()].forEach((fn) => fn()),
    pending: () => timers.size,
  };
}

const CONTAINER = {} as HTMLElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: Partial<Parameters<typeof createInvisibleTurnstile>[0]> = {}) {
  const f = fakeApi();
  const timers = fakeTimers();
  const source = createInvisibleTurnstile({
    load: f.load,
    container: () => CONTAINER,
    siteKey: '1x00000000000000000000BB',
    language: () => 'cs',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { ...f, timers, source };
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof TurnstileError && error.code === code);

test('příprava předem: render bez spuštění challenge; po kliknutí jen execute (žádný render navíc)', async () => {
  const t = setup();
  await t.source.prepare();
  await t.source.prepare();
  assert.equal(t.rendered.length, 1, 'opakovaná příprava nevytváří další widget');
  assert.equal(t.executed.length, 0, 'příprava challenge nespouští');
  const options = t.widget('w1');
  assert.equal(options.sitekey, '1x00000000000000000000BB');
  assert.equal(options.action, TURNSTILE_ACTION);
  assert.equal(options.execution, 'execute');
  assert.equal(options.appearance, 'interaction-only');
  assert.equal(options['refresh-expired'], 'never');
  assert.equal(options.retry, 'never');
  assert.equal(options.language, 'cs');
  const token = t.source.getToken();
  await tick();
  assert.equal(t.rendered.length, 1, 'kliknutí nečeká na nový render');
  assert.deepEqual(t.executed, [CONTAINER]);
  options.callback('XXXX.DUMMY.TOKEN.XXXX');
  assert.equal(await token, 'XXXX.DUMMY.TOKEN.XXXX');
  assert.equal(t.timers.pending(), 0);
  assert.match(TURNSTILE_ACTION, /^[A-Za-z0-9_-]{1,32}$/);
});

test('každý widget vydá nejvýš jeden token: po tokenu se odstraní a na pozadí se připraví čerstvý', async () => {
  const t = setup();
  await t.source.prepare();
  const first = t.source.getToken();
  await tick();
  t.widget('w1').callback('TOKEN-1');
  assert.equal(await first, 'TOKEN-1');
  await tick();
  assert.deepEqual(t.removed, ['w1'], 'použitý widget odstraněn');
  assert.equal(t.rendered.length, 2, 'další widget připravený předem');
  assert.equal(t.executed.length, 1, 'nová challenge se sama nespustí');
  const second = t.source.getToken();
  await tick();
  assert.equal(t.rendered.length, 2, 'druhé odeslání použije připravený widget');
  t.widget('w1').callback('TOKEN-STARY');
  t.widget('w1')['expired-callback']();
  t.widget('w2').callback('TOKEN-2');
  assert.equal(await second, 'TOKEN-2');
  assert.equal(t.loads() >= 1, true);
});

test('bez přípravy předem: getToken widget vykreslí a pak spustí', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  assert.equal(t.rendered.length, 1);
  assert.deepEqual(t.executed, [CONTAINER]);
  t.widget('w1').callback('TOKEN-1');
  assert.equal(await token, 'TOKEN-1');
});

test('vypršení tokenu nic neobnovuje ani nespouští', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.widget('w1').callback('TOKEN-1');
  await token;
  t.widget('w1')['expired-callback']();
  assert.equal(t.executed.length, 1);
});

test('chyba, timeout challenge i prázdný token → turnstile-failed; použitý widget se nahradí čerstvým', async () => {
  const errored = setup();
  const a = errored.source.getToken();
  await tick();
  assert.equal(errored.widget('w1')['error-callback'](), true, 'chyba ošetřená');
  await rejectsWith(a, 'turnstile-failed');
  await tick();
  assert.deepEqual(errored.removed, ['w1']);
  assert.equal(errored.rendered.length, 2, 'pro další pokus připravený nový widget');

  const interactive = setup();
  const b = interactive.source.getToken();
  await tick();
  interactive.widget('w1')['timeout-callback']();
  await rejectsWith(b, 'turnstile-failed');

  const empty = setup();
  const c = empty.source.getToken();
  await tick();
  empty.widget('w1').callback('');
  await rejectsWith(c, 'turnstile-failed');
});

test('vlastní časový limit: challenge bez odpovědi → turnstile-failed, pozdní token se ignoruje', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.timers.fire();
  await rejectsWith(token, 'turnstile-failed');
  t.widget('w1').callback('POZDE');
  await tick();
  const next = t.source.getToken();
  await tick();
  t.widget('w2').callback('TOKEN-2');
  assert.equal(await next, 'TOKEN-2', 'pozdní token starého widgetu se nepřiřadí novému požadavku');
});

test('nenačtený skript, chybějící kontejner nebo výjimka renderu → turnstile-unavailable; příprava se zopakuje', async () => {
  let attempts = 0;
  const ok = fakeApi();
  const flaky = setup({ load: async () => (++attempts === 1 ? Promise.reject(new Error('turnstile-load')) : ok.api) });
  await assert.rejects(flaky.source.prepare());
  const token = flaky.source.getToken();
  await tick();
  ok.widget('w1').callback('TOKEN-1');
  assert.equal(await token, 'TOKEN-1', 'po chybě načtení se skript zkusí znovu');

  await rejectsWith(setup({ container: () => null }).source.getToken(), 'turnstile-unavailable');
  const broken = fakeApi();
  broken.api.render = () => {
    throw new Error('invalid sitekey');
  };
  await rejectsWith(setup({ load: async () => broken.api }).source.getToken(), 'turnstile-unavailable');
});

test('odpojení formuláře během challenge: požadavek skončí (turnstile-unavailable), widget se odstraní, nic se nepřipravuje', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.source.dispose();
  await rejectsWith(token, 'turnstile-unavailable');
  await tick();
  assert.deepEqual(t.removed, ['w1']);
  assert.equal(t.rendered.length, 1);
  await rejectsWith(t.source.getToken(), 'turnstile-unavailable');
});
