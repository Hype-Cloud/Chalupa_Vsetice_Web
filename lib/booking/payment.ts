// Veřejný kód rezervace, splatnost a platební údaje (QR Platba / SPAYD).
//
// Jediný zdroj pravdy pro platební data rezervace: používá je odpověď POST /api/reservations
// a stejná data (paymentInstructions) má použít i budoucí potvrzovací e-mail. Čisté funkce bez
// I/O; bankovní účet přichází výhradně ze serverové konfigurace (secret PAYMENT_IBAN).

import { todayInPrague, type IsoDate } from '../availability/dates.ts';

/** Nejvyšší pořadí rezervace v jednom pražském dni (NN v kódu DDMMYYNN). */
export const MAX_DAILY_RESERVATIONS = 99;
/** Splatnost od vytvoření rezervace (hodiny, absolutní čas v UTC). */
export const PAYMENT_DUE_HOURS = 24;
export const PAYMENT_CURRENCY = 'CZK';

/** Pražský kalendářní den vytvoření rezervace – určuje DDMMYY v kódu i čítač NN. */
export const reservationCodeDay = (createdAt: Date): IsoDate => todayInPrague(createdAt);

/** `YYYY-MM-DD` → `DDMMYY`. */
export const reservationCodePrefix = (day: IsoDate) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;

/** Veřejný kód rezervace `DDMMYYNN`, zároveň variabilní symbol. */
export function formatReservationCode(day: IsoDate, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_DAILY_RESERVATIONS) throw new RangeError('reservation-sequence-out-of-range');
  return `${reservationCodePrefix(day)}${String(sequence).padStart(2, '0')}`;
}

/** Splatnost = vytvoření + 24 h (ISO 8601, UTC). */
export const paymentDueAt = (createdAt: Date | string) => new Date(new Date(createdAt).getTime() + PAYMENT_DUE_HOURS * 3_600_000).toISOString();

/** Zpráva pro příjemce u platby. */
export const paymentMessage = (reservationCode: string) => `Rezervace ${reservationCode}`;

// --- bankovní účet ---

export interface PaymentAccount {
  /** IBAN bez mezer, velkými písmeny. */
  iban: string;
  /** Tuzemský formát účtu pro ruční platbu: `[předčíslí-]číslo/kód banky`. */
  accountNumber: string;
}

const CZ_IBAN = /^CZ\d{22}$/;

/** Kontrolní součet IBAN (ISO 13616, mod 97). */
function ibanChecksumValid(iban: string): boolean {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/**
 * Český IBAN z konfigurace → účet pro platbu, nebo null při chybějící/nevalidní hodnotě.
 * Tuzemské číslo účtu se z IBAN odvozuje, aby se ruční údaje a QR Platba nemohly rozejít.
 */
export function paymentAccountFromIban(raw: string | undefined): PaymentAccount | null {
  const iban = raw?.replace(/\s+/g, '').toUpperCase() ?? '';
  if (!CZ_IBAN.test(iban) || !ibanChecksumValid(iban)) return null;
  const bank = iban.slice(4, 8);
  const prefix = iban.slice(8, 14).replace(/^0+/, '');
  const number = iban.slice(14).replace(/^0+/, '');
  if (!number) return null;
  return { iban, accountNumber: `${prefix ? `${prefix}-` : ''}${number}/${bank}` };
}

// --- SPAYD (QR Platba) ---

export interface SpaydInput {
  iban: string;
  amountCzk: number;
  variableSymbol: string;
  message: string;
}

/**
 * Deterministický SPAYD 1.0 (Short Payment Descriptor, QR Platba). Klíče po ACC v abecedním
 * pořadí. Hodnoty nesmí obsahovat `*` (oddělovač).
 */
export function buildSpayd({ iban, amountCzk, variableSymbol, message }: SpaydInput): string {
  if (!CZ_IBAN.test(iban)) throw new RangeError('spayd-invalid-iban');
  if (!Number.isInteger(amountCzk) || amountCzk <= 0 || amountCzk > 9_999_999) throw new RangeError('spayd-invalid-amount');
  if (!/^\d{1,10}$/.test(variableSymbol)) throw new RangeError('spayd-invalid-variable-symbol');
  if (message.includes('*') || message.length > 60) throw new RangeError('spayd-invalid-message');
  return ['SPD', '1.0', `ACC:${iban}`, `AM:${amountCzk}.00`, `CC:${PAYMENT_CURRENCY}`, `MSG:${message}`, `X-VS:${variableSymbol}`].join('*');
}

// --- platební údaje rezervace ---

/** Platební údaje pro hosta (success panel, budoucí e-mail). */
export interface PaymentInstructions {
  /** 100 % serverem potvrzené ceny rezervace. */
  amountCzk: number;
  currency: typeof PAYMENT_CURRENCY;
  accountNumber: string;
  iban: string;
  variableSymbol: string;
  message: string;
  /** Splatnost (ISO 8601, UTC). */
  dueAt: string;
  /** SPAYD pro QR Platbu (QR se vykresluje lokálně). */
  spayd: string;
}

export function paymentInstructions(
  reservation: { code: string; priceCzk: number; variableSymbol: string; paymentDueAt: string },
  account: PaymentAccount,
): PaymentInstructions {
  const message = paymentMessage(reservation.code);
  return {
    amountCzk: reservation.priceCzk,
    currency: PAYMENT_CURRENCY,
    accountNumber: account.accountNumber,
    iban: account.iban,
    variableSymbol: reservation.variableSymbol,
    message,
    dueAt: reservation.paymentDueAt,
    spayd: buildSpayd({ iban: account.iban, amountCzk: reservation.priceCzk, variableSymbol: reservation.variableSymbol, message }),
  };
}
