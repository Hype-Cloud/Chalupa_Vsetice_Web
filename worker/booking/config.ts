// GET /api/booking-config – veřejné runtime nastavení rezervačního formuláře pro frontend.
//
// Vrací:
// - bookingEnabled: BOOKING_API_ENABLED === "true" (stejná podmínka jako POST /api/reservations),
// - turnstileSiteKey: veřejný site key Turnstile widgetu (secret zůstává jen ve Workeru),
//   jen když je rezervace zapnutá,
// - rules: veřejná rezervační pravidla nemovitosti (vždy, i při vypnuté rezervaci – nejde
//   o povolení rezervovat). Zatím z TS konstant lib/booking/rules.ts, které používá i serverová
//   validace a výpočet ceny; budoucí zdroj (D1) kontrakt nezmění.
// Žádné další interní nastavení. V produkci je bookingEnabled false a web nabízí poptávku
// přes e-chalupy.

import { BOOKING_HORIZON_DAYS, CAPACITY, MAX_NIGHTS, MIN_NIGHTS, PRICE_PER_NIGHT } from '../../lib/booking/rules.ts';
import { json } from '../http.ts';

export interface BookingConfigEnv {
  BOOKING_API_ENABLED?: string;
  /** Veřejný site key Turnstile (proměnná, ne secret). */
  TURNSTILE_SITE_KEY?: string;
}

/** Část odpovědi, kterou dnes čte frontend (components/booking/bookingConfig.ts). */
export interface BookingConfig {
  bookingEnabled: boolean;
  turnstileSiteKey: string | null;
}

/** Veřejná rezervační pravidla nemovitosti (celá čísla). */
export interface BookingRules {
  /** Nejvyšší počet hostů. */
  capacity: number;
  minNights: number;
  maxNights: number;
  /** Nejpozdější příjezd: kolik dní dopředu od dnešního dne (Europe/Prague). */
  bookingHorizonDays: number;
  /** Výchozí cena noci (Kč) – jen orientační; cenu pobytu počítá vždy POST /api/quote. */
  basePricePerNightCzk: number;
}

/** Celá odpověď GET /api/booking-config. */
export interface BookingConfigResponse extends BookingConfig {
  rules: BookingRules;
}

/** Pravidla ze stejných konstant, které vynucuje serverová validace a výpočet ceny. */
export function bookingRules(): BookingRules {
  return {
    capacity: CAPACITY,
    minNights: MIN_NIGHTS,
    maxNights: MAX_NIGHTS,
    bookingHorizonDays: BOOKING_HORIZON_DAYS,
    basePricePerNightCzk: PRICE_PER_NIGHT,
  };
}

export function bookingConfig(env: BookingConfigEnv): BookingConfigResponse {
  const bookingEnabled = env.BOOKING_API_ENABLED === 'true';
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return { bookingEnabled, turnstileSiteKey: bookingEnabled && siteKey ? siteKey : null, rules: bookingRules() };
}

export function handleBookingConfig(request: Request, env: BookingConfigEnv): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method-not-allowed' }, { status: 405, cacheControl: 'no-store', headers: { allow: 'GET, HEAD' } });
  }
  return json(bookingConfig(env), { cacheControl: 'no-store' });
}
