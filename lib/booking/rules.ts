// Pravidla pobytu a ceny. Používá je web (orientační cena) i Worker (závazná validace).

/** Cena za celou chalupu a noc (Kč). */
export const PRICE_PER_NIGHT = 3000;
/** Kapacita chalupy. */
export const CAPACITY = 7;
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 30;
/** Nejpozdější příjezd: kolik dní dopředu lze rezervovat (odpovídá 12 měsícům kalendáře). */
export const BOOKING_HORIZON_DAYS = 365;

/** Cena pobytu v Kč. Na serveru jediný zdroj ceny, hodnota z prohlížeče se nepoužívá. */
export function priceFor(nights: number): number {
  return nights * PRICE_PER_NIGHT;
}
