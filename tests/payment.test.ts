import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSpayd,
  formatReservationCode,
  MAX_DAILY_RESERVATIONS,
  paymentAccountFromIban,
  paymentDueAt,
  paymentInstructions,
  reservationCodeDay,
  reservationCodePrefix,
} from '../lib/booking/payment.ts';
import { inflateSync } from 'node:zlib';
import { qrMatrix, qrPngBytes, qrRendering, qrSvgPath, QR_QUIET_MODULES } from '../components/booking/paymentQr.ts';
import { copyText } from '../components/booking/clipboard.ts';
import { FAKE_ACCOUNT_NUMBER, FAKE_PAYMENT_IBAN } from './helpers.ts';

// Čisté platební funkce (kód rezervace, splatnost, účet, SPAYD). Jen fiktivní účet (banka 9999).
const ROOT = join(import.meta.dirname, '..');

test('pražské datum → DDMMYY: UTC čas kolem půlnoci, zimní i letní čas', () => {
  const day = (iso: string) => reservationCodeDay(new Date(iso));
  assert.equal(day('2026-10-09T21:59:59Z'), '2026-10-09'); // 23:59:59 SELČ
  assert.equal(day('2026-10-09T22:30:00Z'), '2026-10-10'); // 00:30 SELČ – příklad ze zadání
  assert.equal(day('2030-01-10T22:59:59Z'), '2030-01-10'); // 23:59:59 SEČ
  assert.equal(day('2030-01-10T23:00:00Z'), '2030-01-11');
  assert.equal(day('2030-12-31T23:30:00Z'), '2031-01-01'); // přelom roku
  assert.equal(reservationCodePrefix('2026-10-10'), '101026');
  assert.equal(reservationCodePrefix('2031-01-01'), '010131');
});

test('kód DDMMYYNN: NN 01–99, mimo rozsah výjimka (žádné 00 ani přetečení)', () => {
  assert.equal(formatReservationCode('2026-10-10', 2), '10102602');
  assert.equal(formatReservationCode('2026-10-10', 1), '10102601');
  assert.equal(formatReservationCode('2026-10-10', MAX_DAILY_RESERVATIONS), '10102699');
  for (const n of [0, 100, -1, 1.5, Number.NaN]) assert.throws(() => formatReservationCode('2026-10-10', n), RangeError, String(n));
});

test('splatnost: konec pražského dne (23:59:59), ve kterém uplyne 24 h od vytvoření; uloženo v UTC', () => {
  // Příklad ze zadání: 10. 10. 2026 02:42 v Praze → do 11. 10. 2026 23:59:59 (SELČ = UTC+2).
  assert.equal(paymentDueAt('2026-10-10T00:42:00.000Z'), '2026-10-11T21:59:59.000Z');
  // Zima (UTC+1).
  assert.equal(paymentDueAt('2030-01-10T10:00:00.000Z'), '2030-01-11T22:59:59.000Z');
  // Pražská půlnoc: 23:59:59 vs. 00:00 dalšího dne posune splatnost o den.
  assert.equal(paymentDueAt('2030-01-10T22:59:59.000Z'), '2030-01-11T22:59:59.000Z');
  assert.equal(paymentDueAt('2030-01-10T23:00:00.000Z'), '2030-01-12T22:59:59.000Z');
  // Konec SELČ 27. 10. 2030 a začátek SELČ 31. 3. 2030.
  assert.equal(paymentDueAt(new Date('2030-10-26T12:00:00Z')), '2030-10-27T22:59:59.000Z');
  assert.equal(paymentDueAt('2030-03-30T23:30:00.000Z'), '2030-04-01T21:59:59.000Z');
  // Host má vždy aspoň 24 h a nejvýš necelých 48 h.
  for (let minutes = 0; minutes < 2 * 24 * 60; minutes += 37) {
    const created = Date.UTC(2030, 9, 26, 0, 0) + minutes * 60_000;
    const hours = (Date.parse(paymentDueAt(new Date(created))) - created) / 3_600_000;
    assert.ok(hours >= 24 && hours < 48, `${new Date(created).toISOString()}: ${hours} h`);
  }
});

test('IBAN z konfigurace: jen platný český IBAN; tuzemské číslo účtu se z něj odvodí', () => {
  assert.deepEqual(paymentAccountFromIban(FAKE_PAYMENT_IBAN), { iban: FAKE_PAYMENT_IBAN, accountNumber: FAKE_ACCOUNT_NUMBER });
  // Mezery a malá písmena z konfigurace se normalizují.
  assert.deepEqual(paymentAccountFromIban(' cz19 9999 0000 0012 3456 7890 '), { iban: FAKE_PAYMENT_IBAN, accountNumber: FAKE_ACCOUNT_NUMBER });
  // S předčíslím (fiktivní účet 19-2000145399/9999, kontrolní součet dopočítaný).
  const withPrefix = paymentAccountFromIban('CZ7799990000192000145399');
  assert.deepEqual(withPrefix, { iban: 'CZ7799990000192000145399', accountNumber: '19-2000145399/9999' });
  for (const bad of [undefined, '', 'CZ1999990000001234567891', 'CZ19999900000012345678', 'DE89370400440532013000', 'CZ0999990000000000000000', 'nesmysl']) {
    assert.equal(paymentAccountFromIban(bad), null, String(bad));
  }
});

test('SPAYD: účet z konfigurace, částka = serverová cena, CZK, VS = kód rezervace, zpráva „Rezervace {kód}“', () => {
  const instructions = paymentInstructions(
    { code: '10102602', priceCzk: 8970, variableSymbol: '10102602', paymentDueAt: '2026-10-11T08:15:00.000Z' },
    paymentAccountFromIban(FAKE_PAYMENT_IBAN)!,
  );
  assert.deepEqual(instructions, {
    amountCzk: 8970,
    currency: 'CZK',
    accountNumber: FAKE_ACCOUNT_NUMBER,
    iban: FAKE_PAYMENT_IBAN,
    variableSymbol: '10102602',
    message: 'Rezervace 10102602',
    dueAt: '2026-10-11T08:15:00.000Z',
    spayd: `SPD*1.0*ACC:${FAKE_PAYMENT_IBAN}*AM:8970.00*CC:CZK*MSG:Rezervace 10102602*X-VS:10102602`,
  });
  // Deterministické: stejný vstup = stejný řetězec.
  assert.equal(buildSpayd({ iban: FAKE_PAYMENT_IBAN, amountCzk: 8970, variableSymbol: '10102602', message: 'Rezervace 10102602' }), instructions.spayd);
});

test('SPAYD odmítne neplatné hodnoty (nic se nevytvoří s chybnou částkou, VS nebo oddělovačem)', () => {
  const ok = { iban: FAKE_PAYMENT_IBAN, amountCzk: 8970, variableSymbol: '10102602', message: 'Rezervace 10102602' };
  for (const bad of [
    { amountCzk: 0 }, { amountCzk: -1 }, { amountCzk: 89.7 }, { variableSymbol: 'CV-7K3M9Q' }, { variableSymbol: '12345678901' },
    { message: 'A*B' }, { message: 'x'.repeat(61) }, { iban: 'DE89370400440532013000' },
  ]) {
    assert.throws(() => buildSpayd({ ...ok, ...bad }), RangeError, JSON.stringify(bad));
  }
});

test('QR Platba: skutečný PNG obrázek ze stejné matice; při selhání převodu SVG, při selhání kódování nic', () => {
  const spayd = buildSpayd({ iban: FAKE_PAYMENT_IBAN, amountCzk: 8970, variableSymbol: '10102602', message: 'Rezervace 10102602' });
  const matrix = qrMatrix(spayd)!;
  assert.ok(matrix.size >= 21);
  // Primárně <img> s PNG (data URL), deterministicky.
  const primary = qrRendering(spayd);
  assert.equal(primary.kind, 'img');
  assert.match((primary as { src: string }).src, /^data:image\/png;base64,/);
  assert.deepEqual(qrRendering(spayd), primary);
  // PNG: paleta 2 barvy, 1 bit, každý pixel odpovídá modulu matice (+ bílý okraj).
  const png = Buffer.from(qrPngBytes(matrix, 2));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16);
  assert.equal(width, (matrix.size + 2 * QR_QUIET_MODULES) * 2);
  assert.deepEqual([...png.subarray(24, 26)], [1, 3]);
  const idat = png.indexOf('IDAT');
  const pixels = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const rowBytes = Math.ceil(width / 8) + 1;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dark = (pixels[y * rowBytes + 1 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      const module = matrix.data[Math.floor(y / 2) - QR_QUIET_MODULES]?.[Math.floor(x / 2) - QR_QUIET_MODULES] ?? false;
      assert.equal(dark, module, `pixel ${x},${y}`);
    }
  }
  // Selže jen převod na obrázek → SVG ze stejné matice.
  assert.deepEqual(qrRendering(spayd, () => { throw new Error('png'); }), { kind: 'svg', size: matrix.size, d: qrSvgPath(matrix) });
  // Selže samotné kódování → žádné QR (UI rozbalí ruční platební údaje).
  assert.deepEqual(qrRendering('x'.repeat(10_000)), { kind: 'none' });
  const source = [...['paymentQr.ts', 'PaymentDetails.tsx', 'CopyButton.tsx', 'clipboard.ts'].map((f) => join('components/booking', f)), 'lib/booking/qr.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|dangerouslySetInnerHTML|getContext\(|toDataURL\(/);
});

test('kopírování platebních údajů: Clipboard API, záložně execCommand, jinak neúspěch bez výjimky', async () => {
  const written: string[] = [];
  assert.equal(await copyText('1234567890/9999', { clipboard: { writeText: async (text) => void written.push(text) } }), true);
  assert.deepEqual(written, ['1234567890/9999']);
  const fakeDocument = (result: boolean) => {
    const appended: { value: string }[] = [];
    const area = { value: '', style: {}, setAttribute() {}, select() {}, remove() { appended.pop(); } };
    return {
      appended,
      doc: { body: { appendChild: (el: { value: string }) => appended.push(el) }, createElement: () => area, execCommand: () => (appended[0]?.value === '10102602' ? result : false) } as unknown as Document,
    };
  };
  const ok = fakeDocument(true);
  assert.equal(await copyText('10102602', { clipboard: { writeText: () => Promise.reject(new Error('denied')) }, document: ok.doc }), true);
  assert.equal(ok.appended.length, 0, 'pomocný textarea se odstraní');
  assert.equal(await copyText('10102602', { document: fakeDocument(false).doc }), false);
  assert.equal(await copyText('10102602', {}), false);
});

test('repozitář neobsahuje skutečný český IBAN – jen fiktivní účty banky 9999', () => {
  const skip = new Set(['node_modules', '.git', 'dist', '.next', '.wrangler', '.d1-backups']);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs|json|jsonc|md|sql|css|html|ics|yaml|yml)$/.test(name)) {
        for (const match of readFileSync(path, 'utf8').matchAll(/\bCZ\d{2}(?:\s?\d{4}){5}\b/g)) {
          if (match[0].replace(/\s/g, '').slice(4, 8) !== '9999') found.push(`${path.slice(ROOT.length)}: ${match[0].slice(0, 6)}…`);
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(found, []);
});
