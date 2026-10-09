import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Occupancy } from '../lib/availability/occupancy.ts';
import { EMPTY_STAY, pickDay, type Stay, type StayContext } from '../lib/availability/stay.ts';
import { DAY_FLASH_KEYFRAMES, DAY_FLASH_OPTIONS, nextStayFeedback, type StayFeedback } from '../components/booking/stayFeedback.ts';

const ROOT = join(import.meta.dirname, '..');
const RANGE = { from: '2030-01-01', to: '2031-01-01' };
const ctx: StayContext = { today: '2030-02-20', occupancy: new Occupancy([{ start: '2030-03-01', end: '2030-03-05' }], RANGE) };

// Stejný tok jako kliknutí v BookingSection: validace → stav pobytu → vizuální odezva.
function click(state: { stay: Stay; feedback: StayFeedback | null }, day: string) {
  const result = pickDay(state.stay, day, ctx);
  return { result, stay: result.stay, feedback: nextStayFeedback(state.feedback, result.error, 'calendar', day) };
}

test('too-short: výsledek validace i stav pobytu beze změny, odezva obsahuje kliknutý den', () => {
  const withArrival = pickDay(EMPTY_STAY, '2030-02-24', ctx).stay;
  const state = click({ stay: withArrival, feedback: null }, '2030-02-25');
  assert.deepEqual(state.result, { stay: withArrival, error: 'too-short' });
  assert.deepEqual(state.stay, { arrival: '2030-02-24', departure: null });
  assert.deepEqual(state.feedback, { error: 'too-short', source: 'calendar', attempt: 1, flashDay: '2030-02-25' });
});

test('každý další neplatný klik vytvoří nový trigger, i když chyba too-short trvá', () => {
  let state = { stay: pickDay(EMPTY_STAY, '2030-02-24', ctx).stay, feedback: null as StayFeedback | null };
  const triggers: StayFeedback[] = [];
  for (let i = 0; i < 3; i++) {
    state = click(state, '2030-02-25');
    triggers.push(state.feedback!);
  }
  assert.deepEqual(triggers.map((t) => t.attempt), [1, 2, 3]);
  assert.ok(triggers.every((t) => t.error === 'too-short' && t.flashDay === '2030-02-25'));
  assert.deepEqual(state.stay, { arrival: '2030-02-24', departure: null });
});

test('validní klik ani jiné chyby flash dne nespustí', () => {
  let state = click({ stay: EMPTY_STAY, feedback: null }, '2030-02-24');
  assert.equal(state.feedback, null);
  state = click(state, '2030-02-25');
  assert.equal(state.feedback?.flashDay, '2030-02-25');
  state = click(state, '2030-02-26');
  assert.equal(state.feedback, null, 'platný odjezd odezvu zruší');
  assert.deepEqual(state.stay, { arrival: '2030-02-24', departure: '2030-02-26' });
  const busy = click({ stay: EMPTY_STAY, feedback: null }, '2030-03-02');
  assert.equal(busy.feedback?.error, 'arrival-busy');
  assert.equal(busy.feedback?.flashDay, null);
  assert.equal(nextStayFeedback(null, 'too-short', 'panel', null)?.flashDay, null, 'datumová pole den nezvýrazňují');
});

test('flash dne není trvalý stav: krátká animace bez fill a bez pohybu, den nezíská třídu', () => {
  assert.equal(DAY_FLASH_OPTIONS.fill, 'none');
  assert.ok(Number(DAY_FLASH_OPTIONS.duration) >= 300 && Number(DAY_FLASH_OPTIONS.duration) <= 450);
  assert.ok(DAY_FLASH_KEYFRAMES.every((k) => !('transform' in k) && !('scale' in k) && !('translate' in k)));
  assert.match(String(DAY_FLASH_KEYFRAMES.at(-1)!.boxShadow), /, 0\)$/, 'poslední snímek je průhledný');
  const month = readFileSync(join(ROOT, 'components/booking/CalendarMonth.tsx'), 'utf8');
  assert.doesNotMatch(month, /flash|rejected|too-short/i, 'den v kalendáři nemá error třídu');
});

test('hláška too-short: pulse jen přes transform 700–900 ms, reduced motion bez animace, error barva zůstává', () => {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const rule = css.match(/\.stay-too-short \{([^}]*)\}/)![1];
  assert.match(rule, /display:inline-block/);
  assert.match(rule, /color:#9a3f1f/);
  const duration = Number(rule.match(/animation:stay-too-short-pulse \.(\d+)s/)![1]) * 100;
  assert.ok(duration >= 700 && duration <= 900);
  const keyframes = css.match(/@keyframes stay-too-short-pulse \{(.*)\}\n/)![1];
  assert.deepEqual([...new Set([...keyframes.matchAll(/\{ ([a-z-]+):/g)].map((m) => m[1]))], ['transform']);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.stay-too-short \{ animation:none; \} \}/);
  // Ostatní hlášky a helper texty beze změny.
  assert.match(css, /\.bk-hint \{[^}]*color:#657267;/);
  assert.match(css, /\.booking \.result\.is-error \{ color:#f3d9c9; \}/);
});
