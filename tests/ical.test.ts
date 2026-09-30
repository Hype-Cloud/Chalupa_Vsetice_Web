import test from 'node:test';
import assert from 'node:assert/strict';
import { IcalLimitError, IcalParseError, MAX_EVENTS, parseBusyIntervals } from '../worker/ical.ts';
import { fixture, RANGE_2030 } from './helpers.ts';

const busy = (name: string, range = RANGE_2030) => parseBusyIntervals(fixture(name), range).busy;

test('1: jednodenní a vícedenní obsazenost (DTEND je exkluzivní)', () => {
  assert.deepEqual(busy('01-single-and-multi.ics'), [
    { start: '2030-01-15', end: '2030-01-16' },
    { start: '2030-01-20', end: '2030-01-25' },
  ]);
});

test('2: dvě navazující rezervace se sloučí do jednoho intervalu', () => {
  assert.deepEqual(busy('02-back-to-back.ics'), [{ start: '2030-02-01', end: '2030-02-08' }]);
});

test('3: rezervace přes přelom měsíce', () => {
  assert.deepEqual(busy('03-month-boundary.ics'), [{ start: '2030-01-28', end: '2030-02-03' }]);
});

test('4: rezervace přes přelom roku', () => {
  assert.deepEqual(busy('04-year-boundary.ics'), [{ start: '2030-12-29', end: '2031-01-03' }]);
});

test('5: den odjezdu zůstává volný pro další příjezd', () => {
  assert.deepEqual(busy('05-same-day-turnover.ics'), [{ start: '2030-03-01', end: '2030-03-05' }]);
});

test('6: překrývající se rezervace se sloučí', () => {
  assert.deepEqual(busy('06-overlapping.ics'), [{ start: '2030-04-01', end: '2030-04-10' }]);
});

test('7: neplatný iCal vyhodí chybu, nikdy prázdný kalendář', () => {
  assert.throws(() => parseBusyIntervals(fixture('07-invalid-html.ics'), RANGE_2030), IcalParseError);
  assert.throws(() => parseBusyIntervals(fixture('07-invalid-truncated.ics'), RANGE_2030), IcalParseError);
  assert.throws(() => parseBusyIntervals('', RANGE_2030), IcalParseError);
});

test('platný prázdný kalendář znamená žádnou obsazenost', () => {
  assert.deepEqual(parseBusyIntervals(fixture('14-empty.ics'), RANGE_2030), { busy: [], events: 0, skipped: 0 });
});

test('časovaná událost s TZID i v UTC se převede na noci v Europe/Prague', () => {
  assert.deepEqual(busy('10-timezones.ics'), [
    { start: '2030-05-01', end: '2030-05-04' },
    // 2030-05-10T23:00Z = 11. 5. 01:00 v Praze; odjezd 12. 5. dopoledne
    { start: '2030-05-11', end: '2030-05-12' },
  ]);
});

test('zrušené události (STATUS:CANCELLED) se ignorují', () => {
  assert.deepEqual(busy('11-cancelled.ics'), [{ start: '2030-05-21', end: '2030-05-22' }]);
});

test('opakované události se rozvinou, zrušený výskyt (RECURRENCE-ID) se vynechá', () => {
  assert.deepEqual(busy('12-recurring.ics'), [
    { start: '2030-06-01', end: '2030-06-03' },
    { start: '2030-06-15', end: '2030-06-17' },
  ]);
});

test('chybějící DTEND = jeden den, chybějící DTSTART = událost vynechána', () => {
  const result = parseBusyIntervals(fixture('13-missing-dates.ics'), RANGE_2030);
  assert.deepEqual(result.busy, [
    { start: '2030-07-01', end: '2030-07-02' },
    { start: '2030-07-15', end: '2030-07-16' },
  ]);
  assert.equal(result.skipped, 1);
});

test('intervaly se ořežou na požadovaný rozsah', () => {
  assert.deepEqual(busy('04-year-boundary.ics', { from: '2030-12-31', to: '2031-01-02' }), [{ start: '2030-12-31', end: '2031-01-02' }]);
  assert.deepEqual(busy('01-single-and-multi.ics', { from: '2030-02-01', to: '2030-03-01' }), []);
});

test('výstup obsahuje jen data, žádné texty ani UID z exportu', () => {
  const serialized = JSON.stringify(parseBusyIntervals(fixture('01-single-and-multi.ics'), RANGE_2030));
  assert.ok(!serialized.includes('Smyšlená'));
  assert.ok(!serialized.includes('test.invalid'));
});

test('regrese 2.–4. 10. 2026: časované události ve formátu exportu e-chalup (bez Z a TZID)', () => {
  const result = parseBusyIntervals(fixture('15-echalupy-timed.ics'), { from: '2026-09-28', to: '2027-11-03' });
  assert.deepEqual(result.busy, [
    { start: '2026-10-02', end: '2026-10-04' },
    { start: '2026-12-31', end: '2027-01-02' },
    { start: '2027-08-13', end: '2027-08-15' },
  ]);
  assert.equal(result.events, 3);
  assert.equal(result.skipped, 0);
});

test('datum bez VALUE=DATE (DTSTART:20300102) se nevynechá', () => {
  const result = parseBusyIntervals(fixture('16-bare-dates.ics'), RANGE_2030);
  assert.deepEqual(result.busy, [
    { start: '2030-01-02', end: '2030-01-08' },
    { start: '2030-01-10', end: '2030-01-12' },
  ]);
  assert.equal(result.skipped, 0);
});

test('samostatné rezervace se stejným UID se neztratí', () => {
  assert.deepEqual(busy('17-duplicate-uid.ics'), [
    { start: '2030-01-02', end: '2030-01-04' },
    { start: '2030-02-01', end: '2030-02-05' },
    { start: '2030-03-01', end: '2030-03-03' },
  ]);
});

test('plovoucí čas a TZID bez VTIMEZONE: pozdní večerní příjezd zůstává ve stejném dni', () => {
  assert.deepEqual(busy('18-floating-late.ics'), [
    { start: '2030-01-02', end: '2030-01-04' },
    { start: '2030-01-10', end: '2030-01-12' },
  ]);
});

test('chybné události se spočítají jako vynechané a platné zůstanou', () => {
  const result = parseBusyIntervals(fixture('19-invalid-events.ics'), RANGE_2030);
  assert.equal(result.events, 4);
  assert.equal(result.skipped, 3, 'konec před začátkem, chybějící DTSTART a nečitelné datum');
  // Platná rezervace zůstane; u obráceného intervalu se konzervativně blokuje noc začátku.
  assert.deepEqual(result.busy, [
    { start: '2030-03-01', end: '2030-03-03' },
    { start: '2030-03-10', end: '2030-03-11' },
  ]);
});

test('limit počtu událostí: export nad limitem se odmítne celý', () => {
  const event = (i: number) => `BEGIN:VEVENT\r\nUID:e${i}@test.invalid\r\nDTSTART;VALUE=DATE:20300101\r\nDTEND;VALUE=DATE:20300102\r\nEND:VEVENT\r\n`;
  const calendar = (n: number) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//CS\r\n${Array.from({ length: n }, (_, i) => event(i)).join('')}END:VCALENDAR\r\n`;
  assert.throws(() => parseBusyIntervals(calendar(MAX_EVENTS + 1), RANGE_2030), IcalLimitError);
  assert.equal(parseBusyIntervals(calendar(MAX_EVENTS), RANGE_2030).events, MAX_EVENTS);
});
