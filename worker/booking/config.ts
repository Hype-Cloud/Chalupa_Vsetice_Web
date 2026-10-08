// GET /api/booking-config – veřejné runtime nastavení rezervačního formuláře pro frontend.
//
// Vrací jen to, co frontend potřebuje k rozhodnutí, zda formulář nabídnout:
// - bookingEnabled: BOOKING_API_ENABLED === "true" (stejná podmínka jako POST /api/reservations),
// - turnstileSiteKey: veřejný site key Turnstile widgetu (secret zůstává jen ve Workeru),
//   jen když je rezervace zapnutá.
// Žádné další interní nastavení. V produkci je bookingEnabled false a web nabízí poptávku
// přes e-chalupy.

import { json } from '../http.ts';

export interface BookingConfigEnv {
  BOOKING_API_ENABLED?: string;
  /** Veřejný site key Turnstile (proměnná, ne secret). */
  TURNSTILE_SITE_KEY?: string;
}

export interface BookingConfig {
  bookingEnabled: boolean;
  turnstileSiteKey: string | null;
}

export function bookingConfig(env: BookingConfigEnv): BookingConfig {
  const bookingEnabled = env.BOOKING_API_ENABLED === 'true';
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return { bookingEnabled, turnstileSiteKey: bookingEnabled && siteKey ? siteKey : null };
}

export function handleBookingConfig(request: Request, env: BookingConfigEnv): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method-not-allowed' }, { status: 405, cacheControl: 'no-store', headers: { allow: 'GET, HEAD' } });
  }
  return json(bookingConfig(env), { cacheControl: 'no-store' });
}
