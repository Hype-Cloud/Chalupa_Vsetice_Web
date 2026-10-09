// Cena se na webu nepočítá – zobrazuje se jen totalCzk z /api/quote. PRICE_PER_NIGHT (výchozí cena
// noci na serveru) slouží jen jako orientační údaj „standardně … / noc“ před výběrem termínu.
export { CAPACITY, PRICE_PER_NIGHT } from '../../lib/booking/rules.ts';
/**
 * Minimální délka pobytu uváděná v cenové poznámce panelu – jen informační text. Server ji zatím
 * nevynucuje (závazné limity jsou MIN_NIGHTS / MAX_NIGHTS v lib/booking/rules.ts).
 */
export const MIN_STAY_NOTICE_NIGHTS = 2;
/**
 * Maximální délka poznámky ve formuláři (znaky). Server přijme až NOTE_MAX_LENGTH z
 * worker/booking/validation.ts (2000) – formulář je přísnější, kontrakt se nemění.
 */
export const NOTE_MAX_LENGTH = 500;
/** Orientační počet znaků na řádek poznámky – z něj se odvozuje maximální výška textarey. */
const NOTE_CHARS_PER_ROW = 60;
/** Nejvyšší počet řádků, na který jde poznámku roztáhnout (500 / 60 → 9 řádků). */
export const NOTE_MAX_ROWS = Math.ceil(NOTE_MAX_LENGTH / NOTE_CHARS_PER_ROW);
/** Kolik měsíců dopředu lze v kalendáři procházet (včetně aktuálního). */
export const HORIZON_MONTHS = 12;
/** Oficiální profil a poptávka na e-chalupy.cz. */
export const INQUIRY_URL = 'https://www.e-chalupy.cz/netvorice-ubytovani-vsetice-chalupa-k-pronajmu-o19216';
/** Text odkazu na e-chalupy.cz (název webu, nepřekládá se). */
export const INQUIRY_LABEL = 'e-chalupy.cz ↗';
/** Obsazenost se v otevřené stránce obnovuje po 5 minutách (stejně jako cache Workeru). */
export const REFRESH_MS = 5 * 60_000;
