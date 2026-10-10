import { MIN_NIGHTS } from '../lib/booking/rules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBooking } from '../worker/booking/validation.ts';
import { findExternalConflict, isOwnEcho } from '../worker/booking/external.ts';
import { parseBusyIntervals, parseCalendarEvents } from '../worker/ical.ts';
import { getAvailability, resetAvailabilityMemory, type AvailabilityDeps } from '../worker/availability.ts';
import { RESERVATION_CODE } from '../lib/booking/codes.ts';
import { fixture, RANGE_2030 } from './helpers.ts';

const TODAY = '2030-01-10';
const VALID = { arrival: '2030-02-01', departure: '2030-02-04', guests: 2, firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid', locale: 'cs' };
const fields = (body: unknown) => {
  const result = validateBooking(body, TODAY);
  return result.ok ? [] : result.fields;
};

test('validace: platný požadavek, cena vždy ze serveru', () => {
  const result = validateBooking({ ...VALID, priceCzk: 1, firstName: '  Jan  ' }, TODAY);
  assert.ok(result.ok);
  assert.equal(result.value.nights, 3);
  assert.ok(!('priceCzk' in result.value), 'validace cenu nepočítá ani nepřebírá');
  assert.equal(result.value.firstName, 'Jan');
  assert.equal(result.value.expectedPriceCzk, null);
});

test('validace termínu: minulost, pořadí, délka pobytu, horizont', () => {
  assert.deepEqual(fields({ ...VALID, arrival: '2030-01-09' }), ['arrival']);
  assert.deepEqual(fields({ ...VALID, arrival: TODAY, departure: '2030-01-12' }), []);
  // Minimální délka pobytu MIN_NIGHTS = 2: 1 noc se odmítne, 2 noci projdou.
  assert.equal(MIN_NIGHTS, 2);
  assert.deepEqual(fields({ ...VALID, arrival: '2030-02-01', departure: '2030-02-02' }), ['departure'], '1 noc');
  assert.deepEqual(fields({ ...VALID, arrival: '2030-02-01', departure: '2030-02-03' }), [], '2 noci');
  assert.deepEqual(fields({ ...VALID, departure: '2030-02-01' }), ['departure']);
  assert.deepEqual(fields({ ...VALID, departure: '2030-03-04' }), ['departure'], 'víc než 30 nocí');
  assert.deepEqual(fields({ ...VALID, arrival: '2031-01-11', departure: '2031-01-13' }), ['arrival'], 'víc než 365 dní dopředu');
  assert.deepEqual(fields({ ...VALID, arrival: '2030-02-30' }), ['arrival']);
  assert.deepEqual(fields({ ...VALID, arrival: '2030-2-1' }), ['arrival']);
});

test('validace kapacity: 1–7 hostů, jen celé číslo', () => {
  for (const guests of [1, 7]) assert.deepEqual(fields({ ...VALID, guests }), []);
  for (const guests of [0, 8, 2.5, '3', null, -1]) assert.deepEqual(fields({ ...VALID, guests }), ['guests'], String(guests));
});

test('validace kontaktů: jméno, telefon, e-mail, řídicí znaky', () => {
  assert.deepEqual(fields({ ...VALID, firstName: '', lastName: '   ' }), ['firstName', 'lastName']);
  assert.deepEqual(fields({ ...VALID, firstName: 'Jan\nDESCRIPTION:podvrh' }), ['firstName']);
  assert.deepEqual(fields({ ...VALID, phone: '123' }), ['phone']);
  assert.deepEqual(fields({ ...VALID, phone: '+420 abc 000 000' }), ['phone']);
  assert.deepEqual(fields({ ...VALID, phone: '777123456' }), []);
  assert.deepEqual(fields({ ...VALID, email: 'bez-zavinace.invalid' }), ['email']);
  assert.deepEqual(fields({ ...VALID, email: 'a@b' }), ['email']);
  assert.deepEqual(fields({ ...VALID, expectedPriceCzk: '9000' }), ['expectedPriceCzk']);
  assert.deepEqual(fields(null), ['body']);
  assert.deepEqual(fields([VALID]), ['body']);
});

test('kód rezervace v textu exportu e-chalup: DDMMYYNN jen v našem kontextu, starší CV-… vždy', () => {
  const codes = (text: string) => text.match(RESERVATION_CODE) ?? [];
  assert.deepEqual(codes('Web 10102602 – Jan Testovací'), ['10102602']);
  assert.deepEqual(codes('[TEST] ZRUŠENO – Web 10102602'), ['10102602']);
  assert.deepEqual(codes('REZERVACE Z WEBU\nKód rezervace: 10102602\nVariabilní symbol: 10102602'), ['10102602']);
  assert.deepEqual(codes('Rezervace z webu 10102602 byla zrušena.'), ['10102602']);
  assert.deepEqual(codes('Web CV-7K3M9Q – Jan'), ['CV-7K3M9Q']);
  // Samotné osmimístné číslo (telefon, cizí rezervace) se za náš kód nepovažuje.
  assert.deepEqual(codes('Booking 10102602, tel. 77712345678, Web 101026021'), []);
  assert.deepEqual(codes('Airbnb HM10102602'), []);
});

test('export: událost nese UID a kódy rezervace, API obsazenosti je dál nevrací', () => {
  const { events, total, skipped } = parseCalendarEvents(fixture('20-own-echo.ics'), RANGE_2030);
  assert.equal(total, 3);
  assert.equal(skipped, 0);
  assert.deepEqual(events, [
    { start: '2030-03-01', end: '2030-03-04', uid: 'rezervace-00000000-0000-4000-8000-000000000001@chalupavsetice.cz', codes: [] },
    { start: '2030-03-10', end: '2030-03-12', uid: 'echalupy-555@test.invalid', codes: ['CV-7K3M9Q'] },
    { start: '2030-03-20', end: '2030-03-22', uid: 'airbnb-777@test.invalid', codes: [] },
  ]);
  const serialized = JSON.stringify(parseBusyIntervals(fixture('20-own-echo.ics'), RANGE_2030));
  assert.ok(!serialized.includes('CV-') && !serialized.includes('uid'));
});

test('ozvěna vlastní rezervace z exportu e-chalup se nepovažuje za kolizi se sebou samotnou', () => {
  const { events } = parseCalendarEvents(fixture('20-own-echo.ics'), RANGE_2030);
  const byUid = { icalUid: 'rezervace-00000000-0000-4000-8000-000000000001@chalupavsetice.cz', code: 'CV-AAAAAA' };
  const byCode = { icalUid: 'rezervace-jina@chalupavsetice.cz', code: 'CV-7K3M9Q' };
  // Kontrola vlastní rezervace (např. při budoucí změně nebo potvrzení): její ozvěna nekoliduje.
  assert.equal(findExternalConflict({ arrival: '2030-03-01', departure: '2030-03-04' }, events, byUid), null);
  assert.equal(findExternalConflict({ arrival: '2030-03-10', departure: '2030-03-12' }, events, byCode), null);
  assert.ok(isOwnEcho(events[0], byUid) && isOwnEcho(events[1], byCode));
  // Rozšíření vlastní rezervace do cizí rezervace kolizi najde.
  assert.equal(findExternalConflict({ arrival: '2030-03-10', departure: '2030-03-21' }, events, byCode)?.uid, 'airbnb-777@test.invalid');
  // Pro jinou (novou) rezervaci je ozvěna obsazený termín jako každý jiný.
  assert.equal(findExternalConflict({ arrival: '2030-03-02', departure: '2030-03-03' }, events)?.uid, byUid.icalUid);
  assert.equal(findExternalConflict({ arrival: '2030-03-02', departure: '2030-03-03' }, events, byCode)?.uid, byUid.icalUid);
  // Samotná shoda termínu nestačí: cizí rezervace se stejnými daty zůstává kolizí.
  assert.ok(findExternalConflict({ arrival: '2030-03-20', departure: '2030-03-22' }, events, { icalUid: 'rezervace-x@chalupavsetice.cz', code: 'CV-BBBBBB' }));
});

function availabilityDeps(reservedNights: AvailabilityDeps['reservedNights']): AvailabilityDeps {
  return {
    fetch: (async () => new Response(fixture('01-single-and-multi.ics'))) as unknown as typeof fetch,
    now: () => new Date('2030-01-10T10:00:00Z'),
    cache: null,
    defer: () => undefined,
    log: () => undefined,
    reservedNights,
  };
}

test('/api/availability: vlastní rezervace se sloučí s exportem (i ozvěna stejného termínu)', async () => {
  resetAvailabilityMemory();
  const result = await getAvailability({ ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics' }, availabilityDeps(async () => [
    { start: '2030-01-20', end: '2030-01-25' },
    { start: '2030-01-25', end: '2030-01-27' },
  ]));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.busy, [
    { start: '2030-01-15', end: '2030-01-16' },
    { start: '2030-01-20', end: '2030-01-27' },
  ]);
});

test('/api/availability: výpadek D1 → partial, výběr termínu se zablokuje', async () => {
  resetAvailabilityMemory();
  const result = await getAvailability({ ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics' }, availabilityDeps(async () => Promise.reject(new Error('D1_ERROR'))));
  assert.equal(result.status, 'partial');
  assert.equal(result.incomplete, true);
  assert.equal(result.reason, 'reservations-unavailable');
  assert.equal(result.busy.length, 2, 'obsazenost z e-chalup zůstává');
});
