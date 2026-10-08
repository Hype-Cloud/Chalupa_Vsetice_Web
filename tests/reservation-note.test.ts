import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { handleCreateReservation, type BookingEnv } from '../worker/booking/handler.ts';
import { handleIcalExport } from '../worker/booking/export.ts';
import { cancelReservation } from '../worker/booking/db.ts';
import { SITEVERIFY_URL } from '../worker/booking/turnstile.ts';
import { createTestDatabase } from './d1.ts';
import { fixture } from './helpers.ts';

// Volitelná poznámka hosta (note) v POST /api/reservations. Očekávané hodnoty jsou zapsané
// ručně. Jen smyšlené údaje; Siteverify i export e-chalup jsou falešné.
const EXPORT_TOKEN = 'exportni-token-0123456789abcdef0123456789';
const GUEST = { guests: 2, firstName: 'Jan', lastName: 'Testovací', phone: '+420 000 000 000', email: 'test@example.invalid', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' };
/** Značka v poznámkách, podle které se hledá únik obsahu do logů a odpovědí. */
const MARKER = 'TAJNA-POZNAMKA-7f3a';

let t: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => (t = await createTestDatabase('preview')));
after(() => t.dispose());
beforeEach(() => t.reset());

// Všechny logy ze všech testů – na konci se ověří, že žádný neobsahuje text poznámky.
const allLogs: string[] = [];

function setup() {
  const logs: string[] = [];
  const verifications: unknown[] = [];
  let uuid = 0;
  const env: BookingEnv = {
    ECHALUPY_ICAL_URL: 'https://ical.test.invalid/x.ics', DB: t.db, BOOKING_ENV: 'preview', BOOKING_API_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret', BOOKING_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === SITEVERIFY_URL) {
      verifications.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true });
    }
    return new Response(fixture('01-single-and-multi.ics'));
  }) as typeof fetch;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    handleCreateReservation(
      new Request('https://preview.test.invalid/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
      env,
      {
        fetch: fetchFn,
        now: () => new Date('2030-01-10T10:00:00Z'),
        randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
        log: (m) => (logs.push(m), allLogs.push(m)),
      },
    );
  return { post, logs, verifications };
}

const stay = (extra: Record<string, unknown> = {}) => ({ arrival: '2030-02-01', departure: '2030-02-04', ...GUEST, ...extra });
const storedNotes = async () => (await t.db.prepare('SELECT note FROM reservations ORDER BY created_at, id').all<{ note: string | null }>()).results.map((r) => r.note);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (r: Response): Promise<any> => r.json();

test('1–4: chybějící, null, prázdná a jen bílé znaky → uloží se NULL', async () => {
  const s = setup();
  for (const note of [undefined, null, '', '   ', ' \n\t\r\n ']) {
    await t.reset();
    const response = await s.post(stay(note === undefined ? {} : { note }));
    assert.equal(response.status, 201, JSON.stringify(note));
    assert.deepEqual(await storedNotes(), [null], JSON.stringify(note));
  }
});

test('5: běžný text se uloží (ořízne se jen začátek a konec)', async () => {
  const response = await setup().post(stay({ note: '  Přijedeme kolem 18:00, prosíme o klíče.  ' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await storedNotes(), ['Přijedeme kolem 18:00, prosíme o klíče.']);
});

test('6: víceřádkový text zachová nové řádky; CRLF a CR se sjednotí na LF', async () => {
  const response = await setup().post(stay({ note: 'První řádek\r\nDruhý řádek\rTřetí\n\n\tOdsazený po prázdném řádku' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await storedNotes(), ['První řádek\nDruhý řádek\nTřetí\n\n\tOdsazený po prázdném řádku']);
});

test('7: Unicode, diakritika a emoji (včetně ZWJ sekvencí) projdou beze změny', async () => {
  const note = 'Žluťoučký kůň úpěl ďábelské ódy 🙂 👨‍👩‍👧‍👦 🇨🇿 — „uvozovky“ & <> ½ €';
  const response = await setup().post(stay({ note }));
  assert.equal(response.status, 201);
  assert.deepEqual(await storedNotes(), [note]);
});

test('8: NFC – rozložené a složené znaky se uloží stejně', async () => {
  const s = setup();
  // „é“ a „ů“ jako základní písmeno + kombinační znak (NFD) → složené znaky U+00E9 a U+016F.
  assert.equal((await s.post(stay({ note: 'Cafe\u0301 u\u030a nás' }))).status, 201);
  const [stored] = await storedNotes();
  assert.equal(stored, 'Caf\u00e9 \u016f nás');
  assert.equal(stored, 'Café ů nás');
  assert.equal([...stored!].length, 10);
});

test('9: limit 2000 znaků po normalizaci (počítají se Unicode znaky, ne bajty)', async () => {
  const s = setup();
  const tooLong = await s.post(stay({ note: 'a'.repeat(2001) }));
  assert.equal(tooLong.status, 422);
  assert.deepEqual(await read(tooLong), { error: 'invalid-request', fields: ['note'] });
  // NFD vstup delší než limit, který se po NFC vejde (2000 × „é“ = 4000 code pointů v NFD).
  assert.equal((await s.post(stay({ note: 'e\u0301'.repeat(2000) }))).status, 201);
  await t.reset();
  // Bílé znaky na okrajích se nepočítají.
  assert.equal((await s.post(stay({ note: `   ${'b'.repeat(2000)}\n\n` }))).status, 201);
  await t.reset();
  // 2000 emoji = 8 000 bajtů UTF-8 – vejde se do limitu těla požadavku.
  assert.equal((await s.post(stay({ note: '🙂'.repeat(2000) }))).status, 201);
  assert.deepEqual(await storedNotes(), ['🙂'.repeat(2000)]);
  await t.reset();
  assert.equal((await s.post(stay({ note: '🙂'.repeat(2001) }))).status, 422);
  assert.equal(await t.count('reservations'), 0);
});

test('10: NUL, řídicí znaky, oddělovače řádků, bidi přepisy, neplatné UTF-16 a jiné typy → 422 note', async () => {
  const s = setup();
  for (const note of [
    'a\u0000b', 'zvonek\u0007', 'escape\u001b[31m', 'del\u007f', 'c1\u0085', 'c1\u009b', 'vt\u000b', 'ff\u000c',
    'řádek\u2028', 'odstavec\u2029', '\u000bna začátku', ' \u000c ', 'abc\u202eexe.txt', 'izolace\u2066x\u2069', 'ltr\u202a', 'osamocený \ud800 surrogát', 'konec \udfff',
    42, true, ['text'], { text: 'x' },
  ]) {
    const response = await s.post(stay({ note }));
    assert.equal(response.status, 422, JSON.stringify(note));
    assert.deepEqual(await read(response), { error: 'invalid-request', fields: ['note'] }, JSON.stringify(note));
  }
  assert.equal(s.verifications.length, 0, 'neplatná poznámka se odmítne před Turnstile');
  assert.equal(await t.count('reservations'), 0);
  // Ostatní chybná pole se hlásí spolu s poznámkou v obvyklém pořadí.
  const both = await s.post(stay({ email: 'neplatny', note: 'x\u0000' }));
  assert.deepEqual(await read(both), { error: 'invalid-request', fields: ['email', 'note'] });
});

test('11: text připomínající SQL injection je jen text', async () => {
  const note = `'); DROP TABLE reservations; --\nRobert'); DELETE FROM reserved_nights WHERE ('1'='1`;
  const response = await setup().post(stay({ note }));
  assert.equal(response.status, 201);
  assert.deepEqual(await storedNotes(), [note]);
  assert.equal(await t.count('reservations'), 1);
  assert.equal(await t.count('reserved_nights'), 3);
});

test('12: text připomínající HTML/skript se uloží beze změny (žádná destruktivní sanitizace)', async () => {
  const note = '<script>alert(1)</script> <img src=x onerror="alert(2)"> &amp; &lt;b&gt;';
  const response = await setup().post(stay({ note }));
  assert.equal(response.status, 201);
  assert.deepEqual(await storedNotes(), [note]);
});

test('13: poznámka není ve veřejné odpovědi rezervace ani v replay odpovědi', async () => {
  const s = setup();
  const headers = { 'idempotency-key': 'formular-poznamka-000001' };
  const note = `${MARKER} prosíme dětskou postýlku`;
  const created = await s.post(stay({ note }), headers);
  assert.equal(created.status, 201);
  const createdText = await created.text();
  assert.ok(!createdText.includes(MARKER) && !createdText.includes('"note"'), createdText);
  assert.deepEqual(Object.keys(JSON.parse(createdText).reservation).sort(), ['arrival', 'code', 'departure', 'guests', 'nights', 'priceCzk', 'status', 'variableSymbol']);
  const replayed = await s.post(stay({ note }), headers);
  assert.equal(replayed.status, 200);
  const replayText = await replayed.text();
  assert.ok(!replayText.includes(MARKER) && !replayText.includes('"note"'), replayText);
});

test('14: poznámka se neobjeví v chybových odpovědích ani v logách', async () => {
  const s = setup();
  const note = `${MARKER}\nsoukromá informace`;
  const responses = [
    await s.post(stay({ note, guests: 99 })), // 422 jiné pole
    await s.post(stay({ note: `${MARKER}\u0000` })), // 422 note
    await s.post(stay({ note, expectedPriceCzk: 1 })), // 409 price-mismatch
    await s.post(stay({ note, turnstileToken: '' })), // 400 turnstile-required
  ];
  assert.deepEqual(responses.map((r) => r.status), [422, 422, 409, 400]);
  assert.equal((await s.post(stay({ note }))).status, 201);
  assert.equal((await s.post(stay({ note }))).status, 409, 'obsazený termín');
  for (const response of responses) {
    const text = await response.text();
    assert.ok(!text.includes(MARKER), text);
  }
  assert.ok(s.logs.length > 0);
  assert.ok(s.logs.every((line) => !line.includes(MARKER) && !line.includes('soukromá')), s.logs.join('\n'));
});

test('15: stejný Idempotency-Key + stejná normalizovaná poznámka → replay původní rezervace', async () => {
  const s = setup();
  const headers = { 'idempotency-key': 'formular-poznamka-000002' };
  const first = await s.post(stay({ note: 'Café\nDruhý řádek' }), headers);
  assert.equal(first.status, 201);
  // Jiný zápis téhož textu: NFD, CRLF a bílé znaky na okrajích.
  const again = await s.post(stay({ note: '  Cafe\u0301\r\nDruhý řádek \n' }), headers);
  assert.equal(again.status, 200);
  const body = await read(again);
  assert.equal(body.replayed, true);
  assert.equal(body.reservation.code, (await read(first)).reservation.code);
  assert.equal(await t.count('reservations'), 1);
  // Bez poznámky: chybějící, null i prázdná jsou totéž.
  const empty = { 'idempotency-key': 'formular-poznamka-000003' };
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03' }), empty)).status, 201);
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03', note: null }), empty)).status, 200);
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03', note: '  ' }), empty)).status, 200);
});

test('16: stejný Idempotency-Key + jiná poznámka → 422 idempotency-key-reused, nic se nezapíše', async () => {
  const s = setup();
  const headers = { 'idempotency-key': 'formular-poznamka-000004' };
  assert.equal((await s.post(stay({ note: 'Přijedeme v pátek.' }), headers)).status, 201);
  for (const note of ['Přijedeme v sobotu.', null, 'přijedeme v pátek.']) {
    const response = await s.post(stay({ note }), headers);
    assert.equal(response.status, 422, JSON.stringify(note));
    assert.deepEqual(await read(response), { error: 'idempotency-key-reused' });
  }
  // A naopak: původně bez poznámky, opakování s poznámkou.
  const other = { 'idempotency-key': 'formular-poznamka-000005' };
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03' }), other)).status, 201);
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03', note: 'dodatek' }), other)).status, 422);
  assert.equal(await t.count('reservations'), 2);
});

// Autorizovaný iCal export

const exportCalendar = async () => {
  const response = await handleIcalExport(
    new Request(`https://preview.test.invalid/api/reservations.ics?token=${EXPORT_TOKEN}`),
    { DB: t.db, BOOKING_ENV: 'preview', BOOKING_ICAL_EXPORT_ENABLED: 'true', BOOKING_ICAL_EXPORT_TOKEN: EXPORT_TOKEN },
    { log: (m) => allLogs.push(m) },
  );
  assert.equal(response.status, 200);
  const raw = await response.text();
  const root = new ICAL.Component(ICAL.parse(raw) as unknown[]);
  return { raw, events: root.getAllSubcomponents('vevent') };
};

test('17: poznámka v iCal DESCRIPTION – escapování \\ ; , a nových řádků, žádná injekce vlastností', async () => {
  const note = 'Cesta C:\\data; pes, kočka\nEND:VEVENT\nBEGIN:VEVENT\nUID:podvrh\nSUMMARY:podvrh';
  const response = await setup().post(stay({ note }));
  assert.equal(response.status, 201);
  const { raw, events } = await exportCalendar();
  // Escapovaná podoba (ověřeno na rozbaleném řádku – foldLine smí řádek zalomit kdekoli).
  const unfolded = raw.replace(/\r\n /g, '');
  assert.ok(
    unfolded.includes('\\n\\nPoznámka hosta:\\nCesta C:\\\\data\\; pes\\, kočka\\nEND:VEVENT\\nBEGIN:VEVENT\\nUID:podvrh\\nSUMMARY:podvrh\r\n'),
    unfolded,
  );
  // Text poznámky nevytvořil žádný vlastní řádek ani událost.
  const lines = unfolded.split('\r\n');
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 1);
  assert.ok(!lines.some((l) => l.startsWith('UID:podvrh') || l.startsWith('SUMMARY:podvrh')));
  // Skutečný parser iCal dostane přesně původní text.
  assert.equal(events.length, 1);
  const description = String(events[0].getFirstPropertyValue('description'));
  assert.ok(description.endsWith(`\n\nPoznámka hosta:\n${note}`), description);
  assert.equal(events[0].getFirstPropertyValue('uid'), 'rezervace-00000000-0000-4000-8000-000000000001@chalupavsetice.cz');
});

test('17b: rezervace bez poznámky nemá v exportu blok poznámky; zrušená rezervace poznámku nenese', async () => {
  const s = setup();
  assert.equal((await s.post(stay({ arrival: '2030-02-01', departure: '2030-02-03' }))).status, 201);
  assert.equal((await s.post(stay({ arrival: '2030-03-01', departure: '2030-03-03', note: `${MARKER} zrušit` }))).status, 201);
  const { id } = (await t.db.prepare(`SELECT id FROM reservations WHERE arrival = '2030-03-01'`).first<{ id: string }>())!;
  assert.equal(await cancelReservation(t.db, id, '2030-01-11T10:00:00.000Z'), true);
  const { raw, events } = await exportCalendar();
  assert.equal(events.length, 2);
  assert.ok(!raw.includes('Poznámka hosta'), raw);
  assert.ok(!raw.replace(/\r\n /g, '').includes(MARKER), raw);
});

test('D1 CHECK odmítne poznámku mimo pravidla i při obejití validace', async () => {
  assert.equal((await setup().post(stay({ note: 'platná' }))).status, 201);
  // (Číslo by TEXT afinita převedla na řetězec, proto se zkouší BLOB.)
  for (const value of [`''`, `'${'x'.repeat(2001)}'`, `X'00'`]) {
    await assert.rejects(t.db.prepare(`UPDATE reservations SET note = ${value}`).run(), /CHECK constraint failed/, value);
  }
  await t.db.prepare('UPDATE reservations SET note = NULL').run();
  await t.db.prepare(`UPDATE reservations SET note = '${'y'.repeat(2000)}'`).run();
  assert.deepEqual(await storedNotes(), ['y'.repeat(2000)]);
});

test('žádný log z testů poznámek neobsahuje obsah poznámky', () => {
  assert.ok(allLogs.length > 0);
  assert.ok(allLogs.every((line) => !line.includes(MARKER) && !/DROP TABLE|<script>|Café|kočka/i.test(line)), allLogs.join('\n'));
});
