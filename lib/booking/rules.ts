// Pravidla pobytu a ceny. Limity pobytu používá web (výběr a hlášky) i Worker (závazná validace).

import { TIME_ZONE } from '../availability/dates.ts';

/**
 * Výchozí cena za celou chalupu a noc (Kč): na serveru fallback pro noci bez vlastní ceny v D1
 * (daily_prices) ve worker/booking/pricing.ts. Web ji ukazuje jen jako orientační „standardně
 * … / noc“ před výběrem termínu; cenu pobytu nikdy nepočítá (bere ji z /api/quote).
 */
export const PRICE_PER_NIGHT = 2990;
/** Kapacita chalupy. */
export const CAPACITY = 7;
export const MIN_NIGHTS = 2;
export const MAX_NIGHTS = 30;
/** Nejpozdější příjezd: kolik dní dopředu lze rezervovat (odpovídá 12 měsícům kalendáře). */
export const BOOKING_HORIZON_DAYS = 365;

/**
 * Časy pobytu v místním čase chalupy (HH:MM, pásmo TIME_ZONE): událost v kalendáři začíná
 * příjezdem v CHECK_IN a končí odjezdem v CHECK_OUT. Jediný zdroj pro ICS i e-mail.
 */
export const STAY_TIMES = { checkIn: '14:00', checkOut: '11:00', timeZone: TIME_ZONE } as const;
