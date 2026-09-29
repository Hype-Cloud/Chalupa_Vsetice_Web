import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals, Occupancy } from '../lib/availability/occupancy.ts';
import { EMPTY_STAY, pickDay, setArrival, setDeparture, type StayContext } from '../lib/availability/stay.ts';

const RANGE = { from: '2030-01-01', to: '2031-01-01' };
// Smyšlená rezervace: noci 1.–4. 3. 2030, odjezd 5. 3.
const occupancy = new Occupancy([{ start: '2030-03-01', end: '2030-03-05' }], RANGE);
const ctx: StayContext = { today: '2030-02-20', occupancy };

test('mergeIntervals řadí, slučuje překryvy i navazující intervaly a zahazuje prázdné', () => {
  assert.deepEqual(
    mergeIntervals([
      { start: '2030-04-04', end: '2030-04-10' },
      { start: '2030-04-01', end: '2030-04-06' },
      { start: '2030-04-10', end: '2030-04-12' },
      { start: '2030-05-01', end: '2030-05-01' },
    ]),
    [{ start: '2030-04-01', end: '2030-04-12' }],
  );
});

test('5: den příjezdu a odjezdu cizích hostů', () => {
  assert.equal(occupancy.day('2030-02-28'), 'free');
  assert.equal(occupancy.day('2030-03-01'), 'checkin');
  assert.equal(occupancy.day('2030-03-03'), 'busy');
  assert.equal(occupancy.day('2030-03-05'), 'checkout');
  assert.equal(occupancy.day('2030-03-06'), 'free');
});

test('5: nový pobyt může končit v den příjezdu a začínat v den odjezdu jiných hostů', () => {
  const before = pickDay(pickDay(EMPTY_STAY, '2030-02-26', ctx).stay, '2030-03-01', ctx);
  assert.deepEqual(before, { stay: { arrival: '2030-02-26', departure: '2030-03-01' }, error: null });
  const after = pickDay(EMPTY_STAY, '2030-03-05', ctx);
  assert.deepEqual(after, { stay: { arrival: '2030-03-05', departure: null }, error: null });
});

test('mimo známý rozsah je obsazenost neznámá', () => {
  assert.equal(occupancy.night('2031-02-01'), 'unknown');
  assert.equal(occupancy.day('2031-02-01'), 'unknown');
  assert.equal(new Occupancy([], null).night('2030-03-10'), 'unknown');
});

test('10: pokus vybrat obsazený den jako příjezd', () => {
  assert.deepEqual(pickDay(EMPTY_STAY, '2030-03-02', ctx), { stay: EMPTY_STAY, error: 'arrival-busy' });
  assert.deepEqual(pickDay(EMPTY_STAY, '2030-03-01', ctx).error, 'arrival-busy');
});

test('10: pobyt přes obsazené období se odmítne a výběr příjezdu zůstane', () => {
  const withArrival = pickDay(EMPTY_STAY, '2030-02-27', ctx).stay;
  assert.deepEqual(pickDay(withArrival, '2030-03-07', ctx), { stay: withArrival, error: 'range-busy' });
});

test('výběr v minulosti se odmítne', () => {
  assert.equal(pickDay(EMPTY_STAY, '2030-02-19', ctx).error, 'past');
  assert.equal(setArrival(EMPTY_STAY, '2030-02-01', ctx).error, 'past');
});

test('kliknutí na dřívější den než příjezd nastaví nový příjezd', () => {
  const stay = pickDay(EMPTY_STAY, '2030-02-25', ctx).stay;
  assert.deepEqual(pickDay(stay, '2030-02-22', ctx).stay, { arrival: '2030-02-22', departure: null });
});

test('po dokončeném výběru začne nový výběr', () => {
  const stay = { arrival: '2030-02-21', departure: '2030-02-24' };
  assert.deepEqual(pickDay(stay, '2030-02-26', ctx).stay, { arrival: '2030-02-26', departure: null });
});

test('datumová pole používají stejnou validaci jako kalendář', () => {
  assert.equal(setDeparture(EMPTY_STAY, '2030-02-25', ctx).error, 'no-arrival');
  const stay = setArrival(EMPTY_STAY, '2030-02-24', ctx).stay;
  assert.equal(setDeparture(stay, '2030-02-24', ctx).error, 'order');
  assert.equal(setDeparture(stay, '2030-03-02', ctx).error, 'range-busy');
  assert.deepEqual(setDeparture(stay, '2030-03-01', ctx).stay, { arrival: '2030-02-24', departure: '2030-03-01' });
  // Posun příjezdu do obsazeného období zruší odjezd a vrátí chybu
  assert.equal(setArrival({ arrival: '2030-02-24', departure: '2030-03-01' }, '2030-03-02', ctx).error, 'arrival-busy');
});

test('bez načtené obsazenosti nelze vybrat žádný termín', () => {
  assert.equal(pickDay(EMPTY_STAY, '2030-02-25', { today: '2030-02-20', occupancy: null }).error, 'unknown');
});
