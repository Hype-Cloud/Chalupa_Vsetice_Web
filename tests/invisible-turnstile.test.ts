import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvisibleTurnstile, TURNSTILE_ACTION, TurnstileError, type TurnstileApi } from '../components/booking/invisibleTurnstile.ts';

// Invisible Turnstile na klientu: token až na vyžádání (execution: execute), každá challenge
// v čerstvém widgetu, žádné automatické obnovování, pozdní callbacky se ignorují.

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
  const api: TurnstileApi = {
    render: (_el, options) => {
      const id = `w${rendered.length + 1}`;
      rendered.push({ id, options: options as Options });
      return id;
    },
    execute: (el) => void executed.push(el),
    remove: (id) => void removed.push(id),
  };
  const latest = () => rendered[rendered.length - 1].options;
  return { api, rendered, removed, executed, latest };
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
    load: async () => f.api,
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

test('token až po execute: render bez automatického spuštění, bez obnovování a opakování', async () => {
  const t = setup();
  assert.equal(t.rendered.length, 0, 'před odesláním se nic nespouští');
  const token = t.source.getToken();
  await tick();
  assert.equal(t.rendered.length, 1);
  const options = t.latest();
  assert.equal(options.sitekey, '1x00000000000000000000BB');
  assert.equal(options.action, TURNSTILE_ACTION);
  assert.equal(options.execution, 'execute');
  assert.equal(options.appearance, 'interaction-only');
  assert.equal(options['refresh-expired'], 'never');
  assert.equal(options.retry, 'never');
  assert.equal(options.language, 'cs');
  assert.deepEqual(t.executed, [CONTAINER], 'challenge spuštěná explicitně');
  options.callback('XXXX.DUMMY.TOKEN.XXXX');
  assert.equal(await token, 'XXXX.DUMMY.TOKEN.XXXX');
  assert.equal(t.timers.pending(), 0);
  assert.match(TURNSTILE_ACTION, /^[A-Za-z0-9_-]{1,32}$/);
});

test('každý další token = čerstvý widget; pozdní callback starého widgetu se ignoruje', async () => {
  const t = setup();
  const first = t.source.getToken();
  await tick();
  const old = t.latest();
  old.callback('TOKEN-1');
  assert.equal(await first, 'TOKEN-1');
  const second = t.source.getToken();
  await tick();
  assert.deepEqual(t.removed, ['w1'], 'předchozí widget odstraněn');
  assert.equal(t.rendered.length, 2);
  old.callback('TOKEN-STARY');
  old['expired-callback']();
  t.latest().callback('TOKEN-2');
  assert.equal(await second, 'TOKEN-2');
});

test('vypršení tokenu nic neobnovuje ani nespouští', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.latest().callback('TOKEN-1');
  await token;
  t.latest()['expired-callback']();
  assert.equal(t.rendered.length, 1);
  assert.equal(t.executed.length, 1);
});

test('chyba, timeout challenge i prázdný token → turnstile-failed a widget se odstraní', async () => {
  const errored = setup();
  const a = errored.source.getToken();
  await tick();
  assert.equal(errored.latest()['error-callback'](), true, 'chyba ošetřená');
  await rejectsWith(a, 'turnstile-failed');
  assert.deepEqual(errored.removed, ['w1']);

  const interactive = setup();
  const b = interactive.source.getToken();
  await tick();
  interactive.latest()['timeout-callback']();
  await rejectsWith(b, 'turnstile-failed');

  const empty = setup();
  const c = empty.source.getToken();
  await tick();
  empty.latest().callback('');
  await rejectsWith(c, 'turnstile-failed');
});

test('vlastní časový limit: challenge bez odpovědi → turnstile-failed, pozdní token se ignoruje', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.timers.fire();
  await rejectsWith(token, 'turnstile-failed');
  t.latest().callback('POZDE');
});

test('nenačtený skript, chybějící kontejner nebo výjimka renderu → turnstile-unavailable', async () => {
  await rejectsWith(setup({ load: async () => Promise.reject(new Error('turnstile-load')) }).source.getToken(), 'turnstile-unavailable');
  await rejectsWith(setup({ container: () => null }).source.getToken(), 'turnstile-unavailable');
  const broken = fakeApi();
  broken.api.render = () => {
    throw new Error('invalid sitekey');
  };
  await rejectsWith(setup({ load: async () => broken.api }).source.getToken(), 'turnstile-unavailable');
});

test('odpojení formuláře během challenge: požadavek skončí (turnstile-unavailable), widget se odstraní', async () => {
  const t = setup();
  const token = t.source.getToken();
  await tick();
  t.source.dispose();
  await rejectsWith(token, 'turnstile-unavailable');
  assert.deepEqual(t.removed, ['w1']);
  await rejectsWith(t.source.getToken(), 'turnstile-unavailable');
});
