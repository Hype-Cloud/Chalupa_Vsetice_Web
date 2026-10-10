// Identifikátory rezervace z webu. Veřejný kód DDMMYYNN přiděluje D1 (lib/booking/payment.ts,
// worker/booking/db.ts); interní ID (UUID) host nikdy nevidí.

/**
 * Veřejný kód rezervace v textu události exportu e-chalup (SUMMARY/DESCRIPTION) – podle něj se
 * pozná ozvěna vlastní rezervace. Rozpoznává:
 * - starší kód `CV-7K3M9Q` (rezervace před migrací 0008),
 * - kód `DDMMYYNN` jen v kontextu, který zapisuje náš export („Web 10102602“,
 *   „Kód rezervace: 10102602“, „z webu 10102602“) – samotné osmimístné číslo (telefon, jiný
 *   identifikátor) se za kód nepovažuje.
 */
export const RESERVATION_CODE = /\bCV-[0-9A-HJKMNP-TV-Z]{6}\b|(?<=(?:\bWeb|\bwebu|Kód rezervace:) )\d{8}(?!\d)/g;

/** Stabilní UID pro iCal událost rezervace (nemění se při úpravách rezervace). */
export const icalUidFor = (id: string) => `rezervace-${id}@chalupavsetice.cz`;
