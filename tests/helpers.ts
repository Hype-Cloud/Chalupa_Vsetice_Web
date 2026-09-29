import { readFileSync } from 'node:fs';

/** Syntetický iCal soubor ze složky tests/fixtures (jen smyšlené rezervace). */
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Rozsah dat pro testy: rok 2030 a začátek 2031. */
export const RANGE_2030 = { from: '2030-01-01', to: '2031-03-01' };
