import type { IsoDate } from './dates.ts';

/**
 * Obsazené noci v intervalu [start, end): noc začínající dnem `start` je obsazená,
 * `end` je den odjezdu (stejně jako exkluzivní DTEND celodenní iCal události).
 */
export interface BusyInterval {
  start: IsoDate;
  end: IsoDate;
}

/**
 * - `ok`: data z poslední synchronizace jsou čerstvá.
 * - `stale`: poslední synchronizace selhala, zobrazují se starší (ale platná) data.
 * - `unavailable`: obsazenost není známá; klient nesmí dny prezentovat jako volné.
 */
export type AvailabilityStatus = 'ok' | 'stale' | 'unavailable';

export interface AvailabilityResponse {
  status: AvailabilityStatus;
  /** Obsazené intervaly (sloučené, seřazené), jen v rozsahu `range`. */
  busy: BusyInterval[];
  /** Čas poslední úspěšné synchronizace s e-chalupami (ISO 8601), nebo null. */
  updatedAt: string | null;
  /** Čas, kdy Worker stav vyhodnotil (ISO 8601). */
  checkedAt: string;
  /** Rozsah dat, pro který odpověď platí; mimo něj je obsazenost neznámá. */
  range: { from: IsoDate; to: IsoDate };
}
