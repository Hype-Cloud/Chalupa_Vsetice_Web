// Uživatelský vstup data: vždy den → měsíc → rok (DD.MM.RRRR) ve všech jazycích, interně ISO.
//
// Psaní se nevaliduje po znacích: rozepsaná hodnota („07.1“) je `partial`, ne chyba.
// Neexistující datum (32.12.2026, 29.02.2027) je `invalid` – nikdy se tiše neopraví na jiné.

import { isoFromParts, type IsoDate } from '../../lib/availability/dates.ts';

export type DateInputParse =
  | { status: 'empty' }
  /** Rozepsané datum – zatím bez chyby. */
  | { status: 'partial' }
  /** Úplný tvar DD.MM.RRRR, ale takové datum neexistuje. */
  | { status: 'invalid' }
  /** Neodpovídá tvaru DD.MM.RRRR (písmena, příliš číslic…) – chyba se ukáže až při blur. */
  | { status: 'malformed' }
  | { status: 'valid'; iso: IsoDate };

const COMPLETE = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/;
const PARTIAL = /^\d{1,2}(\.\s*(\d{1,2}(\.\s*\d{0,4})?)?)?$/;

/** ISO → DD.MM.RRRR (s úvodními nulami). */
export function formatDateInput(iso: IsoDate): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function parseDateInput(text: string): DateInputParse {
  const value = text.trim();
  if (value === '') return { status: 'empty' };
  const match = COMPLETE.exec(value);
  if (match) {
    const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { status: 'invalid' };
    return { status: 'valid', iso: isoFromParts(year, month, day) };
  }
  return PARTIAL.test(value) ? { status: 'partial' } : { status: 'malformed' };
}
