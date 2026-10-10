import { readFileSync } from 'node:fs';

/** Syntetický iCal soubor ze složky tests/fixtures (jen smyšlené rezervace). */
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Rozsah dat pro testy: rok 2030 a začátek 2031. */
export const RANGE_2030 = { from: '2030-01-01', to: '2031-03-01' };

/**
 * Fiktivní platební účet pro testy: kód banky 9999 neexistuje, kontrolní součet IBAN je platný.
 * Skutečný účet je jen v Cloudflare secretu PAYMENT_IBAN, nikdy v repozitáři.
 */
export const FAKE_PAYMENT_IBAN = 'CZ1999990000001234567890';
export const FAKE_ACCOUNT_NUMBER = '1234567890/9999';
