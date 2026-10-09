// Runtime nastavení rezervačního formuláře z GET /api/booking-config.
// Chyba nebo neplatná odpověď = formulář vypnutý (fail-closed): web nabízí poptávku přes e-chalupy.

import type { BookingConfig } from '../../worker/booking/config.ts';

export type { BookingConfig };

export const BOOKING_DISABLED: BookingConfig = { bookingEnabled: false, turnstileSiteKey: null };

export async function fetchBookingConfig(fetchFn: typeof fetch, signal?: AbortSignal): Promise<BookingConfig> {
  try {
    const response = await fetchFn('/api/booking-config', { headers: { accept: 'application/json' }, signal });
    if (!response.ok) return BOOKING_DISABLED;
    const data = (await response.json()) as Partial<BookingConfig>;
    const siteKey = typeof data.turnstileSiteKey === 'string' && data.turnstileSiteKey !== '' ? data.turnstileSiteKey : null;
    // Bez site key nejde formulář ověřit – nenabízí se.
    return data.bookingEnabled === true && siteKey ? { bookingEnabled: true, turnstileSiteKey: siteKey } : BOOKING_DISABLED;
  } catch {
    return BOOKING_DISABLED;
  }
}
