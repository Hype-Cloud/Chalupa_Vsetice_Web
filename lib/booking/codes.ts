// Identifikátory rezervace z webu.

/** Crockford Base32 bez I, L, O, U – kód se dobře čte i diktuje. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Veřejný kód rezervace, např. `CV-7K3M9Q`. Objeví se i v textu rezervace v e-chalupách. */
export const RESERVATION_CODE = /\bCV-[0-9A-HJKMNP-TV-Z]{6}\b/g;

export function newReservationCode(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(6));
  return `CV-${Array.from(bytes, (b) => ALPHABET[b % 32]).join('')}`;
}

/** Stabilní UID pro iCal událost rezervace (nemění se při úpravách rezervace). */
export const icalUidFor = (id: string) => `rezervace-${id}@chalupavsetice.cz`;
