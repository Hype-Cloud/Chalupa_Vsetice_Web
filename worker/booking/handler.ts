// POST /api/reservations – založení rezervace v D1 (veřejný rezervační formulář).
//
// Endpoint je zapnutý jen tam, kde BOOKING_API_ENABLED = "true" (zatím jen Worker Previews);
// jinak vrací 404 jako neexistující cesta. Ochrana veřejného požadavku:
// 1. rate limit podle IP (Workers Rate Limiting binding BOOKING_RATE_LIMITER),
// 2. Cloudflare Turnstile ověřený na serveru (TURNSTILE_SECRET_KEY), fail-closed,
// 3. volitelný Bearer token BOOKING_API_TOKEN – jen pro neveřejné prostředí (Preview).
// Dvojí rezervaci téže noci brání D1 (reserved_nights), ne rate limit.
// Do e-chalup, Airbnb ani Booking.com nic nezapisuje; export e-chalup jen čte.
//
// Stabilní chybové kódy (`{ "error": "<kód>" }`) – viz README, sekce Chybové kódy.

import { diffDays, todayInPrague } from '../../lib/availability/dates.ts';
import { icalUidFor } from '../../lib/booking/codes.ts';
import { paymentAccountFromIban, type PaymentAccount } from '../../lib/booking/payment.ts';
import type { AvailabilityDeps } from '../availability.ts';
import { json } from '../http.ts';
import { secretEquals, sha256 } from '../secrets.ts';
import { databaseEnvironment, DuplicateError, findByIdempotencyKey, insertReservation, NightsTakenError, ReservationCodesExhaustedError, type ReservationSummary } from './db.ts';
import { sendReservationConfirmation, type ConfirmationEnv } from './confirmation.ts';
import { checkExternalAvailability } from './external.ts';
import { reservationResponse, type ReservationResponse } from './response.ts';
import { PricingDataError, quoteStay, type Quote } from './pricing.ts';
import { isTestTurnstileSecret, MAX_TOKEN_LENGTH, verifyTurnstile } from './turnstile.ts';
import { validateBooking, type ValidBooking } from './validation.ts';

export interface BookingEnv extends ConfirmationEnv {
  ECHALUPY_ICAL_URL?: string;
  DB?: D1Database;
  /** Označení prostředí (production / preview); musí souhlasit s meta.environment v D1. */
  BOOKING_ENV?: string;
  /** "true" zapne POST /api/reservations. V produkci zatím nenastaveno. */
  BOOKING_API_ENABLED?: string;
  /** Secret (volitelný): dodatečný Bearer token pro neveřejné prostředí. Nikdy ne do klientského JS. */
  BOOKING_API_TOKEN?: string;
  /** Secret: Turnstile secret key. V produkci nesmí být testovací klíč. */
  TURNSTILE_SECRET_KEY?: string;
  /** Workers Rate Limiting binding (wrangler.jsonc → ratelimits). */
  BOOKING_RATE_LIMITER?: RateLimiter;
  /**
   * Secret: český IBAN pro platbu rezervace (QR Platba i ruční údaje; tuzemské číslo účtu se
   * z něj odvozuje). Chybějící nebo nevalidní hodnota = rezervace se nezaloží (fail closed).
   * Hodnota se nikdy neloguje.
   */
  PAYMENT_IBAN?: string;
}

/** Podmnožina Workers Rate Limiting API. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface BookingDeps extends Pick<AvailabilityDeps, 'fetch' | 'now' | 'log'> {
  randomUUID: () => string;
  /**
   * Odložení práce po odeslání odpovědi (ctx.waitUntil). Bez něj (testy) se na potvrzovací
   * e-mail čeká před odpovědí; výsledek odpovědi to nemění.
   */
  defer?: (promise: Promise<unknown>) => void;
}

// 16 KB: poznámka (až 2000 znaků) může mít v UTF-8 až 8 000 bajtů.
const MAX_BODY_BYTES = 16 * 1024;
/** Perioda rate limitu ve wrangler.jsonc (s) – pro hlavičku Retry-After. */
const RATE_LIMIT_PERIOD_S = 60;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,100}$/;
/** Pokusy při kolizi náhodného interního ID (UUID). */
const ID_ATTEMPTS = 3;

const noStore = (status: number, body: unknown, headers?: HeadersInit) => json(body, { status, cacheControl: 'no-store', headers });
const failure = (status: number, error: string, extra: Record<string, unknown> = {}) => noStore(status, { error, ...extra });

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Bearer token z hlavičky Authorization. */
const tokenMatches = (header: string | null, token: string) => secretEquals(header?.startsWith('Bearer ') ? header.slice(7) : '', token);

/**
 * Otisk obsahu požadavku pro opakované odeslání se stejným Idempotency-Key (z normalizovaných
 * hodnot). Normalizovaná poznámka se připojí jen tehdy, když je vyplněná – bez poznámky zůstává
 * otisk stejný jako před jejím zavedením.
 */
const requestHash = async (b: ValidBooking) =>
  hex(await sha256(JSON.stringify([b.arrival, b.departure, b.guests, b.firstName, b.lastName, b.phone, b.email, ...(b.note === null ? [] : [b.note])])));

/**
 * Úspěšná odpověď: veřejný souhrn rezervace a platební údaje (bez interního ID, kontaktů,
 * poznámky a secrets). Frontend nic nepřepočítává – cena, splatnost i SPAYD jsou ze serveru.
 */
const created = (body: ReservationResponse, status = 201, replayed = false) => noStore(status, { ...body, ...(replayed ? { replayed: true } : {}) });

export async function handleCreateReservation(request: Request, env: BookingEnv, deps: BookingDeps): Promise<Response> {
  try {
    return await createReservation(request, env, deps);
  } catch {
    // Neočekávaná chyba: žádné detaily klientovi ani do logu.
    deps.log('reservations: internal error');
    return failure(500, 'internal-error');
  }
}

async function createReservation(request: Request, env: BookingEnv, deps: BookingDeps): Promise<Response> {
  // Vypnutý endpoint se neliší od neexistující cesty.
  if (env.BOOKING_API_ENABLED !== 'true') return failure(404, 'not-found');
  if (request.method !== 'POST') return noStore(405, { error: 'method-not-allowed' }, { allow: 'POST' });

  const token = env.BOOKING_API_TOKEN?.trim();
  const url = env.ECHALUPY_ICAL_URL?.trim();
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!url || !env.DB || !env.BOOKING_ENV || !turnstileSecret || !env.BOOKING_RATE_LIMITER) {
    deps.log('reservations: not configured');
    return failure(503, 'not-configured');
  }
  // Bez platných platebních údajů se rezervace nezakládá: host by nevěděl, kam a jak zaplatit.
  const account = paymentAccountFromIban(env.PAYMENT_IBAN);
  if (!account) {
    deps.log('reservations: payment not configured');
    return failure(503, 'not-configured');
  }
  // Testovací Turnstile klíč by v produkci propustil každého – produkce se s ním nespustí.
  if (env.BOOKING_ENV === 'production' && isTestTurnstileSecret(turnstileSecret)) {
    deps.log('reservations: turnstile test key in production');
    return failure(503, 'not-configured');
  }
  if (token && !(await tokenMatches(request.headers.get('authorization'), token))) return failure(401, 'unauthorized');

  // Rate limit před čímkoli dražším. Klíč = IP (Workers Rate Limiting, sdílené napříč instancemi
  // v rámci lokality Cloudflare). Selhání limiteru = odmítnutí.
  const remoteIp = request.headers.get('cf-connecting-ip');
  try {
    const { success } = await env.BOOKING_RATE_LIMITER.limit({ key: `reservations:${remoteIp ?? 'unknown'}` });
    if (!success) {
      deps.log('reservations: rate limited');
      return noStore(429, { error: 'rate-limited' }, { 'retry-after': String(RATE_LIMIT_PERIOD_S) });
    }
  } catch {
    deps.log('reservations: rate limiter unavailable');
    return failure(503, 'service-unavailable');
  }

  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return failure(415, 'unsupported-media-type');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return failure(413, 'payload-too-large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return failure(413, 'payload-too-large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure(400, 'invalid-json');
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) return failure(400, 'invalid-idempotency-key');

  const now = deps.now();
  const createdAt = now.toISOString();
  const today = todayInPrague(now);
  const validation = validateBooking(body, today);
  if (!validation.ok) return failure(422, 'invalid-request', { fields: validation.fields });
  const booking = validation.value;
  const turnstileToken = (body as { turnstileToken?: unknown }).turnstileToken;
  if (typeof turnstileToken !== 'string' || turnstileToken.length === 0 || turnstileToken.length > MAX_TOKEN_LENGTH) {
    return failure(400, 'turnstile-required');
  }
  const db = env.DB;

  try {
    // Pojistka proti záměně databází: Preview nesmí zapisovat do produkční D1 ani naopak.
    const marker = await databaseEnvironment(db);
    if (marker !== env.BOOKING_ENV) {
      deps.log('reservations: database environment mismatch');
      return failure(503, 'database-environment-mismatch');
    }
    const hash = await requestHash(booking);
    // Opakování už úspěšného požadavku (retry po timeoutu, dvojklik) vrátí původní rezervaci –
    // ještě před Turnstile, protože token je jednorázový.
    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(db, idempotencyKey);
      if (existing) return replay(existing, hash, account);
    }

    const human = await verifyTurnstile(turnstileSecret, turnstileToken, { remoteIp, idempotencyKey }, deps.fetch);
    if (!human.ok) {
      if (human.reason === 'unavailable') {
        deps.log(`reservations: turnstile unavailable (${human.detail})`);
        return failure(503, 'turnstile-unavailable');
      }
      deps.log(`reservations: turnstile rejected (${human.codes.join(',') || 'unknown'})`);
      return failure(403, 'turnstile-failed');
    }

    // Cena je vždy spočítaná na serveru stejným výpočtem jako POST /api/quote. Nesouhlasí-li
    // s cenou, kterou host viděl (např. se mezitím změnil ceník), rezervace se nezaloží.
    let quote: Quote;
    try {
      quote = await quoteStay(db, booking);
    } catch (error) {
      if (!(error instanceof PricingDataError)) throw error;
      deps.log('reservations: pricing data invalid');
      return failure(503, 'pricing-unavailable');
    }
    if (booking.expectedPriceCzk !== null && booking.expectedPriceCzk !== quote.totalCzk) {
      return failure(409, 'price-mismatch', { priceCzk: quote.totalCzk });
    }

    // Čerstvá kontrola proti e-chalupám (bez cache). Selhání nebo neúplná data = odmítnutí.
    const external = await checkExternalAvailability(url, booking, deps);
    if (!external.ok) {
      deps.log(`reservations: rejected (${external.reason}${'detail' in external ? `, ${external.detail}` : ''})`);
      return external.reason === 'dates-unavailable' ? failure(409, 'dates-unavailable') : failure(503, external.reason);
    }

    for (let attempt = 1; ; attempt++) {
      const id = deps.randomUUID();
      try {
        const reservation = await insertReservation(db, {
          id,
          icalUid: icalUidFor(id),
          arrival: booking.arrival,
          departure: booking.departure,
          guests: booking.guests,
          firstName: booking.firstName,
          lastName: booking.lastName,
          phone: booking.phone,
          email: booking.email,
          note: booking.note,
          priceCzk: quote.totalCzk,
          idempotencyKey,
          requestHash: hash,
          createdAt,
          locale: booking.locale,
        });
        deps.log('reservations: created');
        const body = reservationResponse(reservation, account);
        // Potvrzovací e-mail jen tady – po skutečně novém zápisu. Replay (níže i před Turnstile)
        // e-mail neposílá. Best-effort: nikdy nevyhazuje, odpověď 201 nemění.
        const confirmation = sendReservationConfirmation(env, body, { guestEmail: booking.email, locale: booking.locale, createdAt }, deps);
        if (deps.defer) deps.defer(confirmation);
        else await confirmation;
        return created(body);
      } catch (error) {
        if (error instanceof NightsTakenError) {
          deps.log('reservations: rejected (nights-taken)');
          return failure(409, 'dates-unavailable');
        }
        if (error instanceof ReservationCodesExhaustedError) {
          // 99 rezervací za pražský den: raději odmítnout než přetéct nebo zdvojit kód.
          deps.log('reservations: rejected (reservation-codes-exhausted)');
          return failure(503, 'reservation-codes-exhausted');
        }
        if (error instanceof DuplicateError && error.column === 'idempotency_key' && idempotencyKey) {
          // Souběžný požadavek se stejným klíčem byl rychlejší.
          const existing = await findByIdempotencyKey(db, idempotencyKey);
          if (existing) return replay(existing, hash, account);
        }
        if (error instanceof DuplicateError && (error.column === 'id' || error.column === 'ical_uid') && attempt < ID_ATTEMPTS) continue;
        throw error;
      }
    }
  } catch {
    // Do logu jde jen druh chyby, nikdy obsah požadavku.
    deps.log('reservations: database error');
    return failure(503, 'database-error');
  }
}

function replay(existing: ReservationSummary & { requestHash: string | null }, hash: string, account: PaymentAccount): Response {
  if (existing.requestHash !== hash) return failure(422, 'idempotency-key-reused');
  const { requestHash: _, ...reservation } = existing;
  return created(reservationResponse(reservation, account), 200, true);
}
