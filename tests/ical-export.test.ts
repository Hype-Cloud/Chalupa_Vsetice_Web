import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { handleIcalExport, type ExportEnv } from '../worker/booking/export.ts';
import { escapeText, foldLine } from '../worker/booking/ics.ts';
import { cancelReservation, insertReservation, type NewReservation } from '../worker/booking/db.ts';
import { icalUidFor } from '../lib/booking/codes.ts';
import { createTestDatabase, failingDatabase } from './d1.ts';

// Jen smyšlené rezervace (rok 2030, domény .invalid).
const TOKEN = 'exportni-token-0123456789abcdef0123456789';

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(() => t.reset());

let counter = 0;
async function reserve(arrival: string, departure: string, overrides: Partial<NewReservation> = {}) {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const r: NewReservation = {
    id,
    publicCode: `CV-${String(counter).padStart(6, '0')}`,
    icalUid: icalUidFor(id),
    arrival,
    departure,
    guests: 2,
    firstName: 'Jan',
    lastName: 'Testovací',
    phone: '+420 000 000 000',
    email: 'test@example.invalid',
    priceCzk: 3000 * Math.round((Date.parse(departure) - Date.parse(arrival)) / 86_400_000),
    idempotencyKey: null,
    requestHash: null,
    vsPrefix: '30',
    createdAt: '2030-01-10T10:00:00.000Z',
    ...overrides,
  };
  await insertReservation(t.db, r);
  return r;
}

function setup(overrides: Partial<ExportEnv> = {}) {
  const logs: string[] = [];
  const env: ExportEnv = { DB: t.db, BOOKING_ENV: 'preview', BOOKING_ICAL_EXPORT_ENABLED: 'true', BOOKING_ICAL_EXPORT_TOKEN: TOKEN, ...overrides };
  const get = (token: string | null = TOKEN, method = 'GET') =>
    handleIcalExport(new Request(`https://preview.test.invalid/api/reservations.ics${token === null ? '' : `?token=${encodeURIComponent(token)}`}`, { method }), env, { log: (m) => logs.push(m) });
  return { logs, get };
}

type Parsed = { raw: string; events: InstanceType<typeof ICAL.Event>[] };
async function parse(response: Response): Promise<Parsed> {
  const raw = await response.text();
  const root = new ICAL.Component(ICAL.parse(raw) as unknown[]);
  return { raw, events: root.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v)) };
}

test('platný ICS: hlavičky, CRLF, zalomení na 75 oktetů, povinné vlastnosti', async () => {
  await reserve('2030-03-01', '2030-03-04');
  const response = await setup().get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(response.headers.get('cache-control')!, /private, no-store/);
  const { raw, events } = await parse(response);
  assert.ok(raw.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(raw.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(raw), 'všechny konce řádků jsou CRLF');
  for (const line of raw.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.equal(events.length, 1);
  const event = events[0];
  for (const property of ['uid', 'summary', 'dtstart', 'dtend', 'dtstamp', 'description']) assert.ok(event.component.hasProperty(property), property);
  assert.match(event.uid, /^rezervace-[0-9a-f-]{36}@chalupavsetice\.cz$/);
});

test('celodenní události s exkluzivním DTEND (den odjezdu), bez časového pásma', async () => {
  await reserve('2030-12-30', '2031-01-02');
  const { raw, events } = await parse(await setup().get());
  assert.match(raw, /\r\nDTSTART;VALUE=DATE:20301230\r\n/);
  assert.match(raw, /\r\nDTEND;VALUE=DATE:20310102\r\n/);
  assert.ok(!raw.includes('TZID'));
  assert.equal(events[0].startDate.isDate, true);
  assert.equal(events[0].endDate.toString(), '2031-01-02');
});

test('více rezervací: seřazené podle příjezdu, každá se svým UID a VS', async () => {
  const b = await reserve('2030-05-10', '2030-05-12');
  const a = await reserve('2030-04-01', '2030-04-03');
  const c = await reserve('2030-05-12', '2030-05-15');
  const { events } = await parse(await setup().get());
  assert.deepEqual(events.map((e) => e.uid), [a.icalUid, b.icalUid, c.icalUid]);
  assert.deepEqual(events.map((e) => e.startDate.toString()), ['2030-04-01', '2030-05-10', '2030-05-12']);
  assert.equal(new Set(events.map((e) => e.description.match(/Variabilní symbol: (\d+)/)![1])).size, 3);
});

test('DESCRIPTION předá správci kód, hosta, kontakty, hosty, cenu, VS a stav platby', async () => {
  const r = await reserve('2030-06-01', '2030-06-03', { guests: 4 });
  const { events } = await parse(await setup().get());
  const lines = events[0].description.split('\n');
  assert.deepEqual(lines, [
    '[TEST] REZERVACE Z WEBU chalupavsetice.cz',
    `Kód rezervace: ${r.publicCode}`,
    'Host: Jan Testovací',
    'Telefon: +420 000 000 000',
    'E-mail: test@example.invalid',
    'Počet hostů: 4',
    'Cena: 6 000 Kč',
    'Variabilní symbol: 30000001',
    'Stav platby: čeká na platbu (ověřit ručně)',
  ]);
  assert.equal(events[0].summary, `[TEST] Web ${r.publicCode} – Jan Testovací`);
});

test('escaping: čárky, středníky, zpětná lomítka a dlouhá čeština projdou beze ztráty', async () => {
  const name = 'Žofie-Příliš, žluťoučká; kůň \\ úpěl ďábelské ódy'.repeat(2).slice(0, 80);
  await reserve('2030-07-01', '2030-07-02', { firstName: name, lastName: 'Novák;Nováková,st.' });
  const { raw, events } = await parse(await setup().get());
  assert.equal(events[0].summary, `[TEST] Web CV-${String(counter).padStart(6, '0')} – ${name} Novák;Nováková,st.`);
  assert.ok(events[0].description.includes(`Host: ${name} Novák;Nováková,st.`));
  assert.ok(raw.includes('\\;') && raw.includes('\\,') && raw.includes('\\\\'));
  assert.equal(escapeText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
  // Zalomení nerozdělí vícebajtový znak a spojením pokračovacích řádků vznikne původní text.
  const long = `DESCRIPTION:${'č'.repeat(100)}`;
  const folded = foldLine(long);
  assert.equal(folded.replace(/\r\n /g, ''), long);
  for (const part of folded.split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75);
});

test('stabilita: nezměněné rezervace dávají stejné UID i stejný text exportu', async () => {
  await reserve('2030-03-01', '2030-03-04');
  await reserve('2030-03-10', '2030-03-12');
  const s = setup();
  const first = await (await s.get()).text();
  const second = await (await s.get()).text();
  assert.equal(first, second);
  await reserve('2030-04-01', '2030-04-02');
  const third = await parse(await s.get());
  assert.equal(third.events.length, 3);
  assert.ok(third.raw.startsWith(first.split('BEGIN:VEVENT')[0]));
  // Původní dvě události se nezměnily.
  for (const block of first.split('BEGIN:VEVENT').slice(1)) assert.ok(third.raw.includes(block.replace('END:VCALENDAR\r\n', '')));
});

const prop = (event: InstanceType<typeof ICAL.Event>, name: string) => event.component.getFirstPropertyValue(name);

test('aktivní rezervace (čeká na platbu i zaplacená) má STATUS:CONFIRMED', async () => {
  const pending = await reserve('2030-03-01', '2030-03-04');
  const paid = await reserve('2030-03-20', '2030-03-22');
  await t.db.prepare(`UPDATE reservations SET status = 'paid' WHERE id = ?1`).bind(paid.id).run();
  const { events } = await parse(await setup().get());
  assert.deepEqual(events.map((e) => [e.uid, prop(e, 'status')]), [[pending.icalUid, 'CONFIRMED'], [paid.icalUid, 'CONFIRMED']]);
  assert.ok(events[1].description.includes('Stav platby: zaplaceno'));
});

test('po zrušení: stejné UID, vyšší SEQUENCE, původní DTSTART/DTEND a STATUS:CANCELLED', async () => {
  const r = await reserve('2030-03-10', '2030-03-12');
  const s = setup();
  const [before] = (await parse(await s.get())).events;
  assert.equal(await cancelReservation(t.db, r.id, '2030-01-11T10:00:00.000Z'), true);
  const [after] = (await parse(await s.get())).events;
  assert.equal(after.uid, before.uid);
  assert.equal(after.sequence, before.sequence + 1);
  assert.equal(after.startDate.toString(), '2030-03-10');
  assert.equal(after.endDate.toString(), '2030-03-12');
  assert.equal(prop(after, 'status'), 'CANCELLED');
  assert.equal(prop(before, 'status'), 'CONFIRMED');
});

test('zrušená rezervace zůstává ve feedu jako tombstone bez osobních a platebních údajů', async () => {
  const keep = await reserve('2030-03-01', '2030-03-04');
  const cancel = await reserve('2030-03-10', '2030-03-12', { firstName: 'Zrušený', email: 'zruseny@example.invalid', phone: '+420 111 111 111' });
  await cancelReservation(t.db, cancel.id, '2030-01-11T10:00:00.000Z');
  const s = setup();
  const first = await s.get();
  const { raw, events } = await parse(first);
  assert.deepEqual(events.map((e) => [e.uid, prop(e, 'status')]), [[keep.icalUid, 'CONFIRMED'], [cancel.icalUid, 'CANCELLED']]);
  const tombstone = raw.slice(raw.indexOf(`UID:${cancel.icalUid}`), raw.indexOf('END:VEVENT', raw.indexOf(`UID:${cancel.icalUid}`)));
  for (const secret of ['Zrušený', 'zruseny@example.invalid', '111 111', 'Kč', 'Variabilní symbol', 'Telefon', 'E-mail']) assert.ok(!tombstone.includes(secret), secret);
  assert.ok(tombstone.includes(cancel.publicCode));
  // Tombstone zůstává i v dalších exportech, beze změny (opakované zrušení nic nezmění).
  assert.equal(await cancelReservation(t.db, cancel.id, '2030-01-12T10:00:00.000Z'), false);
  assert.equal(await (await s.get()).text(), raw);
});

test('prázdná databáze: platný VCALENDAR bez událostí', async () => {
  const response = await setup().get();
  assert.equal(response.status, 200);
  const { raw, events } = await parse(response);
  assert.equal(events.length, 0);
  assert.ok(raw.includes('BEGIN:VCALENDAR') && raw.includes('END:VCALENDAR'));
});

test('export obsahuje jen rezervace z D1 a nic nestahuje (žádná smyčka s exportem e-chalup)', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error('fetch se nemá volat');
  }) as typeof fetch;
  try {
    await reserve('2030-03-01', '2030-03-04');
    const { events } = await parse(await setup().get());
    assert.equal(events.length, 1);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('autorizace: bez tokenu, se špatným nebo krátkým tokenem nic neprozradí (404)', async () => {
  await reserve('2030-03-01', '2030-03-04');
  const s = setup();
  for (const token of [null, '', 'spatny-token', TOKEN.slice(0, -1), `${TOKEN}x`]) {
    const response = await s.get(token);
    assert.equal(response.status, 404, String(token));
    const text = await response.text();
    assert.ok(!text.includes('VCALENDAR') && !text.includes('Testovací'));
  }
  // Token v hlavičce Authorization místo URL se nepřijímá (importér ICS posílá jen URL).
  const header = await handleIcalExport(new Request('https://preview.test.invalid/api/reservations.ics', { headers: { authorization: `Bearer ${TOKEN}` } }), { DB: t.db, BOOKING_ENV: 'preview', BOOKING_ICAL_EXPORT_ENABLED: 'true', BOOKING_ICAL_EXPORT_TOKEN: TOKEN }, { log: () => undefined });
  assert.equal(header.status, 404);
  assert.equal((await s.get(TOKEN, 'POST')).status, 405);
  const head = await s.get(TOKEN, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('produkce: bez BOOKING_ICAL_EXPORT_ENABLED je export 404 i se správným tokenem', async () => {
  await reserve('2030-03-01', '2030-03-04');
  for (const flag of [undefined, 'false', '1']) {
    const response = await setup({ BOOKING_ICAL_EXPORT_ENABLED: flag, BOOKING_ENV: 'production' }).get();
    assert.equal(response.status, 404);
  }
});

test('slabý nebo chybějící secret: export se nespustí (503)', async () => {
  for (const token of [undefined, '', 'kratky-token-1234567890']) {
    assert.equal((await setup({ BOOKING_ICAL_EXPORT_TOKEN: token }).get(token ?? '')).status, 503);
  }
  assert.equal((await setup({ DB: undefined }).get()).status, 503);
});

test('chyba databáze: 503 bez kalendáře, nikdy prázdný VCALENDAR', async () => {
  await reserve('2030-03-01', '2030-03-04');
  const s = setup({ DB: failingDatabase(t.db, 'read') });
  const response = await s.get();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.ok(!(await response.text()).includes('VCALENDAR'));
  assert.deepEqual(s.logs, ['ical-export: failed']);
});

test('nesprávné prostředí (meta.environment ≠ BOOKING_ENV): 503 bez dat', async () => {
  await reserve('2030-03-01', '2030-03-04');
  const s = setup({ BOOKING_ENV: 'production' });
  const response = await s.get();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('Testovací'));
  assert.deepEqual(s.logs, ['ical-export: database environment mismatch']);
});

test('produkční export nemá označení TEST (mimo produkci ano)', async () => {
  const prod = await createTestDatabase('production');
  try {
    await insertReservation(prod.db, {
      id: 'prod-1', publicCode: 'CV-PPPPPP', icalUid: icalUidFor('prod-1'), arrival: '2030-03-01', departure: '2030-03-02', guests: 1,
      firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid', priceCzk: 3000,
      idempotencyKey: null, requestHash: null, vsPrefix: '30', createdAt: '2030-01-10T10:00:00.000Z',
    });
    const response = await handleIcalExport(new Request(`https://x.invalid/api/reservations.ics?token=${TOKEN}`), { DB: prod.db, BOOKING_ENV: 'production', BOOKING_ICAL_EXPORT_ENABLED: 'true', BOOKING_ICAL_EXPORT_TOKEN: TOKEN }, { log: () => undefined });
    const raw = await response.text();
    assert.ok(!raw.includes('[TEST]'));
    assert.match(raw, /SUMMARY:Web CV-PPPPPP – Jan Testovací/);
  } finally {
    await prod.dispose();
  }
});

test('ochrana osobních údajů: logy ani chybové odpovědi neobsahují kontakty, token ani URL', async () => {
  await reserve('2030-03-01', '2030-03-04');
  const s = setup();
  await s.get();
  const denied = await (await s.get('spatny-token')).text();
  const broken = await (await setup({ DB: failingDatabase(t.db, 'read') }).get()).text();
  const everything = [s.logs.join('\n'), denied, broken].join('\n');
  for (const secret of ['Testovací', 'test@example.invalid', '000 000', TOKEN, 'token=', 'CV-']) assert.ok(!everything.includes(secret), secret);
  assert.deepEqual(s.logs, ['ical-export: served (1 events)', 'ical-export: unauthorized']);
});

test('ruční zrušení (UPDATE stavu) dá ve feedu vyšší SEQUENCE a STATUS:CANCELLED', async () => {
  const r = await reserve('2030-08-10', '2030-08-12');
  const s = setup();
  const [before] = (await parse(await s.get())).events;
  await t.db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(r.id).run();
  const [after] = (await parse(await s.get())).events;
  assert.equal(after.uid, before.uid);
  assert.equal(after.sequence, before.sequence + 1);
  assert.equal(prop(after, 'status'), 'CANCELLED');
});
