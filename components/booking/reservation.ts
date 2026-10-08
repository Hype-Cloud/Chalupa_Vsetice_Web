// Odeslání rezervace přes POST /api/reservations (kontrakt worker/booking/handler.ts).
//
// - Cenu počítá jen server: request nese expectedPriceCzk = totalCzk aktuální nabídky
//   z /api/quote; při změně ceny server vrátí 409 price-mismatch a nic nezapíše.
// - Idempotency-Key = jedna logická operace (stejný obsah requestu). Opakování stejné operace
//   po síťové chybě nebo dočasné chybě serveru použije stejný klíč; změna obsahu, nové
//   potvrzení po změně ceny nebo nové ověření Turnstile = nová operace s novým klíčem.
// - Turnstile token se po odpovědi automaticky neresetuje: opakování stejné operace použije
//   stejný token (server ho díky deterministickému idempotency_key pro Siteverify přijme znovu).
//   Reset widgetu jen po turnstile-failed / turnstile-required (a po úspěchu se widget skryje).
// - Nikdy se nic neodesílá automaticky – každé odeslání je kliknutí uživatele.

import type { IsoDate } from '../../lib/availability/dates.ts';
import type { MessageKey } from '../../lib/i18n/index.ts';
import type { ReservationSummary } from '../../worker/booking/db.ts';
import type { BookingRequest } from '../../worker/booking/validation.ts';

export interface ContactDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** Volitelná poznámka hosta; prázdná = null. */
  note: string;
}

export const EMPTY_CONTACT: ContactDraft = { firstName: '', lastName: '', email: '', phone: '', note: '' };

/** Povinné kontaktní údaje vyplněné (formát ověří server – frontend validaci neduplikuje). */
export const contactComplete = (c: ContactDraft) => [c.firstName, c.lastName, c.email, c.phone].every((v) => v.trim() !== '');

/** Tělo POST /api/reservations bez Turnstile tokenu (pole podle BookingRequest). */
export type ReservationPayload = Pick<BookingRequest, 'arrival' | 'departure' | 'guests' | 'firstName' | 'lastName' | 'phone' | 'email' | 'note'> & {
  expectedPriceCzk: number;
};

export function reservationPayload(input: { arrival: IsoDate; departure: IsoDate; guests: number; contact: ContactDraft; expectedPriceCzk: number }): ReservationPayload {
  const { contact } = input;
  return {
    arrival: input.arrival,
    departure: input.departure,
    guests: input.guests,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    note: contact.note.trim() === '' ? null : contact.note,
    expectedPriceCzk: input.expectedPriceCzk,
  };
}

/** Otisk obsahu operace (vše kromě tokenu) – rozhoduje, zda jde o stejnou logickou operaci. */
export const payloadFingerprint = (p: ReservationPayload) =>
  JSON.stringify([p.arrival, p.departure, p.guests, p.firstName, p.lastName, p.email, p.phone, p.note, p.expectedPriceCzk]);

/** Rezervace z odpovědi serveru (veřejný souhrn bez kontaktů). */
export type ReservationConfirmation = Pick<ReservationSummary, 'code' | 'arrival' | 'departure' | 'guests' | 'priceCzk'> & { nights: number };

export type SubmitResult =
  | { kind: 'success'; reservation: ReservationConfirmation; replayed: boolean }
  | { kind: 'price-mismatch'; priceCzk: number }
  | { kind: 'invalid'; fields: string[] }
  | { kind: 'error'; code: string };

/** Kódy, u kterých má smysl stejnou operaci zopakovat (stejný klíč i token). */
const RETRYABLE = new Set([
  'network',
  'turnstile-unavailable',
  'rate-limited',
  'availability-check-failed',
  'availability-incomplete',
  'pricing-unavailable',
  'internal-error',
  'database-error',
  'service-unavailable',
  'not-configured',
  'database-environment-mismatch',
]);
/** Token odmítnutý (nebo chybějící) – reset widgetu a nová operace. */
const NEEDS_NEW_TOKEN = new Set(['turnstile-failed', 'turnstile-required']);

export const isRetryable = (code: string) => RETRYABLE.has(code);

/** Kód chyby → uživatelská hláška (technické kódy ani detaily se nezobrazují). */
export function reservationErrorKey(code: string): MessageKey {
  switch (code) {
    case 'turnstile-required':
      return 'reservation.error.turnstileRequired';
    case 'turnstile-failed':
      return 'reservation.error.turnstileFailed';
    case 'turnstile-unavailable':
      return 'reservation.error.turnstileUnavailable';
    case 'rate-limited':
      return 'reservation.error.rateLimited';
    case 'dates-unavailable':
      return 'reservation.error.datesUnavailable';
    case 'pricing-unavailable':
      return 'reservation.error.pricingUnavailable';
    case 'availability-check-failed':
      return 'reservation.error.availabilityCheckFailed';
    case 'availability-incomplete':
      return 'reservation.error.availabilityIncomplete';
    case 'invalid-request':
      return 'reservation.error.invalidRequest';
    case 'network':
      return 'reservation.error.network';
    default:
      return 'reservation.error.internalError';
  }
}

/** Chybné pole z 422 → hláška u pole. */
export const FIELD_ERROR_KEYS: Record<string, MessageKey> = {
  firstName: 'reservation.fieldError.firstName',
  lastName: 'reservation.fieldError.lastName',
  email: 'reservation.fieldError.email',
  phone: 'reservation.fieldError.phone',
  note: 'reservation.fieldError.note',
};

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

function parseConfirmation(value: unknown): ReservationConfirmation | null {
  const r = (value as { reservation?: Record<string, unknown> } | null)?.reservation;
  if (!r || typeof r.code !== 'string' || typeof r.arrival !== 'string' || typeof r.departure !== 'string') return null;
  if (!isInt(r.guests) || !isInt(r.priceCzk) || !isInt(r.nights)) return null;
  return { code: r.code, arrival: r.arrival, departure: r.departure, guests: r.guests as number, priceCzk: r.priceCzk as number, nights: r.nights as number };
}

/** Jeden požadavek. Nikdy nevyhazuje; síťová chyba / timeout = { code: 'network' }. */
export async function postReservation(
  payload: ReservationPayload,
  turnstileToken: string,
  idempotencyKey: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<SubmitResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetchFn('/api/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ ...payload, turnstileToken }),
      signal,
    });
    body = await response.json().catch(() => undefined);
  } catch {
    return { kind: 'error', code: 'network' };
  }
  const data = (body ?? {}) as { error?: unknown; fields?: unknown; priceCzk?: unknown; replayed?: unknown };
  if (response.status === 201 || response.status === 200) {
    const reservation = parseConfirmation(body);
    return reservation ? { kind: 'success', reservation, replayed: data.replayed === true } : { kind: 'error', code: 'internal-error' };
  }
  if (response.status === 409 && data.error === 'price-mismatch' && isInt(data.priceCzk)) return { kind: 'price-mismatch', priceCzk: data.priceCzk as number };
  if (response.status === 422 && data.error === 'invalid-request') {
    return { kind: 'invalid', fields: Array.isArray(data.fields) ? data.fields.filter((f): f is string => typeof f === 'string') : [] };
  }
  return { kind: 'error', code: typeof data.error === 'string' ? data.error : 'internal-error' };
}

// --- stav odeslání ---

export type SubmissionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; reservation: ReservationConfirmation }
  /** Cena se mezitím změnila: from = cena, kterou uživatel potvrdil; to = cena serveru. */
  | { status: 'price-changed'; fromCzk: number; toCzk: number }
  | { status: 'invalid'; fields: string[] }
  | { status: 'error'; code: string; retryable: boolean };

export const IDLE_SUBMISSION: SubmissionState = { status: 'idle' };

interface Operation {
  key: string;
  fingerprint: string;
}

export interface ReservationControllerDeps {
  post: (payload: ReservationPayload, token: string, key: string) => Promise<SubmitResult>;
  /** Nový náhodný Idempotency-Key (crypto.randomUUID). */
  newKey: () => string;
  onChange: (state: SubmissionState) => void;
  /** Token byl serverem odmítnut nebo chyběl – reset widgetu. */
  onTurnstileReset: () => void;
  /** Server hlásí jinou cenu – znovu načíst autoritativní nabídku (/api/quote). */
  onPriceChanged: () => void;
}

export interface ReservationController {
  /** Vědomé odeslání (kliknutí). Stejný obsah po opakovatelné chybě = stejná operace i klíč. */
  submit: (payload: ReservationPayload, token: string) => Promise<void>;
  /** Změna termínu / hostů: zahodí chybové hlášky (ne úspěch ani probíhající odeslání). */
  dismiss: () => void;
  state: () => SubmissionState;
}

export function createReservationController(deps: ReservationControllerDeps): ReservationController {
  let state: SubmissionState = IDLE_SUBMISSION;
  /** Operace, kterou lze zopakovat (po síťové chybě nebo dočasné chybě serveru). */
  let pending: Operation | null = null;
  const set = (next: SubmissionState) => {
    state = next;
    deps.onChange(next);
  };

  return {
    state: () => state,
    dismiss: () => {
      if (state.status === 'error' || state.status === 'invalid' || state.status === 'price-changed') set(IDLE_SUBMISSION);
    },
    submit: async (payload, token) => {
      if (state.status === 'submitting' || state.status === 'success' || !token) return;
      const fingerprint = payloadFingerprint(payload);
      const operation: Operation = pending && pending.fingerprint === fingerprint ? pending : { key: deps.newKey(), fingerprint };
      pending = operation;
      set({ status: 'submitting' });
      const result = await deps.post(payload, token, operation.key);
      switch (result.kind) {
        case 'success':
          pending = null;
          set({ status: 'success', reservation: result.reservation });
          return;
        case 'price-mismatch':
          // Žádné automatické odeslání; nové potvrzení = nový obsah (expectedPriceCzk) = nový klíč.
          pending = null;
          set({ status: 'price-changed', fromCzk: payload.expectedPriceCzk, toCzk: result.priceCzk });
          deps.onPriceChanged();
          return;
        case 'invalid':
          pending = null;
          set({ status: 'invalid', fields: result.fields });
          return;
        case 'error': {
          const retryable = isRetryable(result.code);
          if (!retryable) pending = null;
          if (NEEDS_NEW_TOKEN.has(result.code)) deps.onTurnstileReset();
          set({ status: 'error', code: result.code, retryable });
        }
      }
    },
  };
}

/** Proč je finální odeslání zablokované (null = lze odeslat). */
export type SubmitBlock = 'stay' | 'quote-loading' | 'quote-unavailable' | 'contact' | 'turnstile' | 'submitting' | null;

export function submitBlock(input: {
  stayComplete: boolean;
  quoteStatus: 'idle' | 'loading' | 'ready' | 'error';
  contact: ContactDraft;
  turnstileToken: string | null;
  submission: SubmissionState;
}): SubmitBlock {
  if (input.submission.status === 'submitting') return 'submitting';
  if (!input.stayComplete) return 'stay';
  if (input.quoteStatus === 'loading') return 'quote-loading';
  if (input.quoteStatus !== 'ready') return 'quote-unavailable';
  if (!contactComplete(input.contact)) return 'contact';
  if (!input.turnstileToken) return 'turnstile';
  return null;
}

export const SUBMIT_BLOCK_KEYS: Record<Exclude<SubmitBlock, null | 'submitting'>, MessageKey> = {
  stay: 'reservation.blocked.stay',
  'quote-loading': 'reservation.blocked.quoteLoading',
  'quote-unavailable': 'reservation.blocked.quoteUnavailable',
  contact: 'reservation.blocked.contact',
  turnstile: 'reservation.blocked.turnstile',
};
