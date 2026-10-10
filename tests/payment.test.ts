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
import { qrPath } from '../components/booking/paymentQr.ts';
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

test('splatnost = vytvoření + 24 h v UTC (i přes změnu času)', () => {
  assert.equal(paymentDueAt('2030-01-10T10:00:00.000Z'), '2030-01-11T10:00:00.000Z');
  assert.equal(paymentDueAt(new Date('2030-10-26T12:00:00Z')), '2030-10-27T12:00:00.000Z'); // 27. 10. 2030 konec SELČ
  assert.equal(paymentDueAt('2030-03-30T23:30:00.000Z'), '2030-03-31T23:30:00.000Z'); // 31. 3. 2030 začátek SELČ
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

test('QR Platba se vykreslí lokálně z SPAYD (uqr), bez externí služby', () => {
  const spayd = buildSpayd({ iban: FAKE_PAYMENT_IBAN, amountCzk: 8970, variableSymbol: '10102602', message: 'Rezervace 10102602' });
  const qr = qrPath(spayd);
  assert.ok(qr && qr.size >= 21 && qr.d.startsWith('M'));
  assert.deepEqual(qrPath(spayd), qr, 'deterministické');
  // Nevykreslitelný vstup → null (UI pak ukáže jen ruční údaje).
  assert.equal(qrPath('x'.repeat(10_000)), null);
  const source = readFileSync(join(ROOT, 'components/booking/paymentQr.ts'), 'utf8') + readFileSync(join(ROOT, 'components/booking/PaymentDetails.tsx'), 'utf8');
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|dangerouslySetInnerHTML/);
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
