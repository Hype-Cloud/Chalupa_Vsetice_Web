// Pravidla pobytu a ceny. Používá je web (orientační cena) i Worker (závazná validace).

/**
 * Výchozí cena za celou chalupu a noc (Kč). Na serveru fallback pro noci bez vlastní ceny
 * v D1 (daily_prices); závaznou cenu počítá jen worker/booking/pricing.ts. Web ji zatím
 * zobrazuje jako orientační.
 */
export const PRICE_PER_NIGHT = 3000;
/** Kapacita chalupy. */
export const CAPACITY = 7;
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 30;
/** Nejpozdější příjezd: kolik dní dopředu lze rezervovat (odpovídá 12 měsícům kalendáře). */
export const BOOKING_HORIZON_DAYS = 365;
