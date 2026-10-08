// Pravidla pobytu a ceny. Limity pobytu používá web (výběr a hlášky) i Worker (závazná validace).

/**
 * Výchozí cena za celou chalupu a noc (Kč) – jen pro server: fallback pro noci bez vlastní ceny
 * v D1 (daily_prices) ve worker/booking/pricing.ts. Web ji nepoužívá, cenu bere z /api/quote.
 */
export const PRICE_PER_NIGHT = 3000;
/** Kapacita chalupy. */
export const CAPACITY = 7;
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 30;
/** Nejpozdější příjezd: kolik dní dopředu lze rezervovat (odpovídá 12 měsícům kalendáře). */
export const BOOKING_HORIZON_DAYS = 365;
