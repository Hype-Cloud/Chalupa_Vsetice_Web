// Serverová validace požadavku na rezervaci a na cenu (POST /api/quote). Cena se z požadavku
// nikdy nepřebírá – počítá ji jen worker/booking/pricing.ts.

import { addDays, diffDays, isIsoDate, type IsoDate } from '../../lib/availability/dates.ts';
import { BOOKING_HORIZON_DAYS, CAPACITY, MAX_NIGHTS, MIN_NIGHTS } from '../../lib/booking/rules.ts';

export interface BookingRequest {
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  /** Volitelná poznámka hosta (normalizovaný prostý text), jinak null. */
  note: string | null;
  /** Cena, kterou host viděl. Slouží jen ke kontrole; uložená cena je vždy spočítaná na serveru. */
  expectedPriceCzk: number | null;
}

export interface ValidBooking extends BookingRequest {
  nights: number;
}

/** Ověřený termín a počet hostů (společné pro rezervaci i cenovou nabídku). */
export interface ValidStay {
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  nights: number;
}

/**
 * Termín a počet hostů: příjezd od dneška nejvýš BOOKING_HORIZON_DAYS dopředu, MIN–MAX_NIGHTS
 * nocí, 1–CAPACITY hostů. `names` = názvy polí v požadavku (pro seznam chybných polí).
 */
export function validateStay(
  input: Record<string, unknown>,
  today: IsoDate,
  names: { arrival: string; departure: string; guests: string } = { arrival: 'arrival', departure: 'departure', guests: 'guests' },
): { ok: true; value: ValidStay } | { ok: false; fields: string[] } {
  const fields: string[] = [];
  const arrival = isIsoDate(input[names.arrival]) ? (input[names.arrival] as IsoDate) : null;
  const departure = isIsoDate(input[names.departure]) ? (input[names.departure] as IsoDate) : null;
  if (!arrival || arrival < today || arrival > addDays(today, BOOKING_HORIZON_DAYS)) fields.push(names.arrival);
  const nights = arrival && departure ? diffDays(arrival, departure) : 0;
  if (!departure || (arrival && (nights < MIN_NIGHTS || nights > MAX_NIGHTS))) fields.push(names.departure);
  const guests = input[names.guests];
  if (typeof guests !== 'number' || !Number.isInteger(guests) || guests < 1 || guests > CAPACITY) fields.push(names.guests);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { arrival: arrival!, departure: departure!, guests: guests as number, nights } };
}

/** Názvy chybných polí (bez hodnot – hodnoty mohou být osobní údaje). */
export type ValidationResult = { ok: true; value: ValidBooking } | { ok: false; fields: string[] };

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ]{7,18}[0-9]$/;
// Řídicí znaky (včetně konců řádků) nepatří do jména ani kontaktu – text půjde i do iCal.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Maximální délka poznámky v Unicode znacích (code pointech) po normalizaci. */
export const NOTE_MAX_LENGTH = 2000;

// Poznámka smí obsahovat nové řádky (LF, CR, CRLF – sjednotí se na LF) a tabulátor; ostatní
// řídicí znaky ne. Odmítá se i U+2028/2029 a bidi přepisy (U+202A–202E, U+2066–2069), kterými by šlo v exportu vizuálně přeházet text.
// ZWJ (U+200D) zůstává povolený kvůli složeným emoji.
// eslint-disable-next-line no-control-regex
const NOTE_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Volitelná poznámka hosta. Chybějící, null, prázdná nebo jen bílé znaky → null.
 * Normalizace: konce řádků na \n, NFC, ořez bílých znaků na začátku a konci; jinak se text
 * nemění (žádná HTML sanitizace – escapuje se až při výstupu podle cílového formátu).
 * @returns undefined = neplatná hodnota
 */
export function validateNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()) return undefined;
  // Zakázané znaky se hledají před ořezem – trim() by jinak tiše odstranil např. VT nebo U+2028 na okraji.
  if (NOTE_FORBIDDEN.test(value)) return undefined;
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (normalized === '') return null;
  return [...normalized].length > NOTE_MAX_LENGTH ? undefined : normalized;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const normalized = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  return normalized.length >= 1 && normalized.length <= max ? normalized : null;
}

export function validateBooking(body: unknown, today: IsoDate): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: ['body'] };
  const input = body as Record<string, unknown>;
  const stay = validateStay(input, today);
  const fields: string[] = stay.ok ? [] : [...stay.fields];

  const firstName = text(input.firstName, 80);
  if (!firstName) fields.push('firstName');
  const lastName = text(input.lastName, 80);
  if (!lastName) fields.push('lastName');

  const phoneText = text(input.phone, 20);
  const digits = phoneText?.replace(/\D/g, '').length ?? 0;
  const phone = phoneText && PHONE.test(phoneText) && digits >= 9 && digits <= 15 ? phoneText : null;
  if (!phone) fields.push('phone');

  const emailText = text(input.email, 254);
  const email = emailText && EMAIL.test(emailText) ? emailText : null;
  if (!email) fields.push('email');

  const note = validateNote(input.note);
  if (note === undefined) fields.push('note');

  const expected = input.expectedPriceCzk;
  if (expected !== undefined && expected !== null && (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0)) fields.push('expectedPriceCzk');

  if (!stay.ok || fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      ...stay.value,
      firstName: firstName!,
      lastName: lastName!,
      phone: phone!,
      email: email!,
      note: note!,
      expectedPriceCzk: typeof expected === 'number' ? expected : null,
    },
  };
}
