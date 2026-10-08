// Cena se na webu nepočítá – zobrazuje se jen totalCzk z /api/quote.
export { CAPACITY } from '../../lib/booking/rules.ts';
/** Kolik měsíců dopředu lze v kalendáři procházet (včetně aktuálního). */
export const HORIZON_MONTHS = 12;
/** Oficiální profil a poptávka na e-chalupy.cz. */
export const INQUIRY_URL = 'https://www.e-chalupy.cz/netvorice-ubytovani-vsetice-chalupa-k-pronajmu-o19216';
/** Obsazenost se v otevřené stránce obnovuje po 5 minutách (stejně jako cache Workeru). */
export const REFRESH_MS = 5 * 60_000;
