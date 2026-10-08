// Cenová nabídka z POST /api/quote. Cenu počítá jen server (worker/booking/pricing.ts);
// klient posílá termín a počet hostů a zobrazuje odpověď beze změny.
//
// Rychlé změny termínu: každý nový požadavek zruší předchozí (AbortController) a odpověď
// staršího požadavku se zahodí i v případě, že fetch zrušení nerespektuje (pořadové číslo).

import { isIsoDate, type IsoDate } from '../../lib/availability/dates.ts';
import type { Stay } from '../../lib/availability/stay.ts';
import type { Quote } from '../../worker/booking/pricing.ts';

export type { Quote };

/** Tělo POST /api/quote (kontrakt worker/booking/quote.ts). */
export interface QuoteRequest {
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  guests: number;
}

export type QuoteError =
  /** 422 invalid-request: názvy chybných polí (arrivalDate, departureDate, guests). */
  | { kind: 'invalid'; fields: string[] }
  /** Chyba serveru (503 pricing-unavailable / database-error / …, 500) nebo nečitelná odpověď. */
  | { kind: 'server'; status: number; code: string | null }
  /** Síťová chyba (offline, timeout). */
  | { kind: 'network' };

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; error: QuoteError } | { ok: false; aborted: true };

export type QuoteState =
  | { status: 'idle' }
  | { status: 'loading'; request: QuoteRequest }
  | { status: 'ready'; request: QuoteRequest; quote: Quote }
  | { status: 'error'; request: QuoteRequest; error: QuoteError };

export const IDLE_QUOTE: QuoteState = { status: 'idle' };

/** Požadavek pro úplný vybraný termín, jinak null (neúplný výběr se neposílá). */
export function quoteRequestFor(stay: Stay, guests: number): QuoteRequest | null {
  if (!stay.arrival || !stay.departure || stay.departure <= stay.arrival) return null;
  if (!Number.isInteger(guests) || guests < 1) return null;
  return { arrivalDate: stay.arrival, departureDate: stay.departure, guests };
}

export const quoteKey = (request: QuoteRequest | null) => (request ? `${request.arrivalDate}|${request.departureDate}|${request.guests}` : '');

const isInt = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;

/**
 * Kontrola tvaru odpovědi (ne výpočet): neznámý pricingMode nebo odpověď k jinému termínu se
 * nezobrazí jako cena, ale jako chyba.
 */
export function isQuoteFor(value: unknown, request: QuoteRequest): value is Quote {
  const q = value as Quote;
  if (!q || typeof q !== 'object') return false;
  if (q.arrivalDate !== request.arrivalDate || q.departureDate !== request.departureDate) return false;
  if (!isInt(q.nights, 1) || !isInt(q.subtotalCzk, 0) || !isInt(q.totalCzk, 0)) return false;
  if (q.pricingMode !== 'nightly' && q.pricingMode !== 'exact-stay') return false;
  if (q.discount !== null) {
    const d = q.discount;
    if (!d || d.type !== 'length' || !isInt(d.minNights, 1) || !isInt(d.percent, 0) || !isInt(d.amountCzk, 0)) return false;
  }
  return Array.isArray(q.nightlyPrices) && q.nightlyPrices.every((n) => n && isIsoDate(n.date) && isInt(n.priceCzk, 0));
}

/** Jeden požadavek na /api/quote. Nikdy nevyhazuje; zrušený požadavek vrátí { aborted: true }. */
export async function fetchQuote(request: QuoteRequest, signal: AbortSignal, fetchFn: typeof fetch): Promise<QuoteResult> {
  const aborted = { ok: false, aborted: true } as const;
  let response: Response;
  let body: unknown;
  try {
    response = await fetchFn('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    body = await response.json().catch(() => undefined);
  } catch {
    return signal.aborted ? aborted : { ok: false, error: { kind: 'network' } };
  }
  if (signal.aborted) return aborted;
  if (response.ok) return isQuoteFor(body, request) ? { ok: true, quote: body } : { ok: false, error: { kind: 'server', status: response.status, code: 'invalid-response' } };
  const data = (body ?? {}) as { error?: unknown; fields?: unknown };
  if (response.status === 422 && data.error === 'invalid-request') {
    const fields = Array.isArray(data.fields) ? data.fields.filter((f): f is string => typeof f === 'string') : [];
    return { ok: false, error: { kind: 'invalid', fields } };
  }
  return { ok: false, error: { kind: 'server', status: response.status, code: typeof data.error === 'string' ? data.error : null } };
}

export interface QuoteLoader {
  /** Nový vstup: změněný termín nebo počet hostů spustí nový požadavek, stejný vstup nic. */
  update: (request: QuoteRequest | null) => void;
  /** Znovu načte aktuální vstup (po chybě). */
  retry: () => void;
  /** Zruší rozpracovaný požadavek (odchod ze stránky). */
  cancel: () => void;
}

export function createQuoteLoader(
  load: (request: QuoteRequest, signal: AbortSignal) => Promise<QuoteResult>,
  onChange: (state: QuoteState) => void,
): QuoteLoader {
  let current: QuoteRequest | null = null;
  let key: string | null = null;
  let sequence = 0;
  let controller: AbortController | null = null;

  const start = async (request: QuoteRequest | null) => {
    controller?.abort();
    controller = null;
    const id = ++sequence;
    if (!request) {
      onChange(IDLE_QUOTE);
      return;
    }
    const own = (controller = new AbortController());
    // Stará cena se během načítání nezobrazuje.
    onChange({ status: 'loading', request });
    const result = await load(request, own.signal);
    if (id !== sequence || own.signal.aborted || 'aborted' in result) return;
    controller = null;
    onChange(result.ok ? { status: 'ready', request, quote: result.quote } : { status: 'error', request, error: result.error });
  };

  return {
    update: (request) => {
      const next = quoteKey(request);
      if (next === key) return;
      key = next;
      current = request;
      void start(request);
    },
    retry: () => {
      if (current) void start(current);
    },
    cancel: () => {
      controller?.abort();
      controller = null;
      sequence++;
      key = null;
    },
  };
}
