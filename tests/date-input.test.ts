import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInput, parseDateInput } from '../components/booking/dateInput.ts';
import { createI18n, LOCALES } from '../lib/i18n/index.ts';

// Uživatelský vstup data: vždy DD.MM.RRRR (den → měsíc → rok), interně ISO YYYY-MM-DD.

test('ISO → DD.MM.RRRR s úvodními nulami', () => {
  assert.equal(formatDateInput('2026-12-07'), '07.12.2026');
  assert.equal(formatDateInput('2030-01-05'), '05.01.2030');
  assert.equal(formatDateInput('2027-10-31'), '31.10.2027');
});

test('DD.MM.RRRR → ISO (i bez úvodních nul a s mezerami po tečkách) a zpět', () => {
  assert.deepEqual(parseDateInput('07.12.2026'), { status: 'valid', iso: '2026-12-07' });
  assert.deepEqual(parseDateInput('7.12.2026'), { status: 'valid', iso: '2026-12-07' });
  assert.deepEqual(parseDateInput('7. 12. 2026'), { status: 'valid', iso: '2026-12-07' });
  assert.deepEqual(parseDateInput('  01.01.2030 '), { status: 'valid', iso: '2030-01-01' });
  for (const iso of ['2026-12-07', '2028-02-29', '2030-01-01', '2027-12-31']) {
    assert.deepEqual(parseDateInput(formatDateInput(iso)), { status: 'valid', iso });
  }
});

test('přestupný rok', () => {
  assert.deepEqual(parseDateInput('29.02.2028'), { status: 'valid', iso: '2028-02-29' });
  assert.deepEqual(parseDateInput('29.02.2000'), { status: 'valid', iso: '2000-02-29' });
  assert.deepEqual(parseDateInput('29.02.2027'), { status: 'invalid' });
  assert.deepEqual(parseDateInput('29.02.2100'), { status: 'invalid' });
});

test('neexistující den nebo měsíc je chyba – nic se tiše neopravuje', () => {
  for (const text of ['32.12.2026', '31.04.2026', '00.12.2026', '30.02.2028', '07.13.2026', '07.00.2026', '07.12.0999']) {
    assert.deepEqual(parseDateInput(text), { status: 'invalid' }, text);
  }
});

test('rozepsané datum není předčasně chyba', () => {
  for (const text of ['0', '07', '07.', '07.1', '07.12', '07.12.', '07.12.2', '07.12.202', '7.', '7. 1', '7. 12. ']) {
    assert.deepEqual(parseDateInput(text), { status: 'partial' }, text);
  }
  assert.deepEqual(parseDateInput(''), { status: 'empty' });
  assert.deepEqual(parseDateInput('   '), { status: 'empty' });
});

test('jiný tvar než DD.MM.RRRR (americký, ISO, písmena) se nepřijme', () => {
  for (const text of ['12/07/2026', '2026-12-07', 'abc', '07-12-2026', '123', '07.12.20266', '07..2026', '7 Dec 2026']) {
    assert.deepEqual(parseDateInput(text), { status: 'malformed' }, text);
  }
});

test('zobrazená data jsou ve všech jazycích den → měsíc → rok; angličtina nikdy měsíc/den', () => {
  const dates = ['2026-12-07', '2026-01-02', '2030-11-03'];
  for (const locale of LOCALES) {
    const i18n = createI18n(locale);
    for (const iso of dates) {
      const day = String(Number(iso.slice(8)));
      const month = String(Number(iso.slice(5, 7)));
      for (const text of [i18n.formatDate(iso), i18n.formatFullDate(iso), i18n.formatDateTime(`${iso}T10:00:00Z`)]) {
        // Žádné „12/07“ ani „12.07“ (měsíc před dnem).
        assert.ok(!new RegExp(`(^|\\D)0?${month}[./]\\s?0?${day}(\\D|$)`).test(text) || month === day, `${locale} ${iso}: ${text}`);
        assert.ok(!/\d{1,2}\/\d{1,2}/.test(text) || locale !== 'en', `${locale}: číselné datum s lomítkem ${text}`);
      }
    }
  }
  const en = createI18n('en');
  assert.equal(en.formatDate('2026-12-07'), 'Mon, 7 Dec 2026');
  assert.equal(en.formatFullDate('2026-12-07'), 'Monday, 7 December 2026');
  assert.equal(en.formatDateTime('2026-12-07T10:00:00Z'), '7 Dec, 11:00');
});

test('nápověda tvaru vstupu je ve všech jazycích den → měsíc → rok', () => {
  assert.deepEqual(
    LOCALES.map((l) => createI18n(l).t('dateInput.placeholder')),
    ['DD.MM.RRRR', 'DD.MM.YYYY', 'TT.MM.JJJJ', 'ДД.ММ.РРРР'],
  );
});
