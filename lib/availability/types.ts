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
 * - `partial`: export se načetl, ale část událostí nešlo spolehlivě převést – obsazenost nemusí být úplná.
 * - `stale`: poslední synchronizace selhala, zobrazují se starší (ale platná) data.
 * - `unavailable`: obsazenost není známá; klient nesmí dny prezentovat jako volné.
 */
export type AvailabilityStatus = 'ok' | 'partial' | 'stale' | 'unavailable';

export interface AvailabilityResponse {
  status: AvailabilityStatus;
  /**
   * Důvod stavu `partial` / `stale` / `unavailable` pro diagnostiku, bez citlivých údajů:
   * `skipped-events`, `not-configured`, `upstream-http-<kód>`, `upstream-timeout`,
   * `upstream-network`, `upstream-invalid-ical`, `upstream-parse`.
   */
  reason?: string;
  /**
   * true = použitý export nešel převést celý (i u záložních dat `stale`). Klient pak smí zobrazit
   * známé obsazené noci, ale ostatní noci nesmí považovat za volné a výběr pobytu blokuje.
   */
  incomplete?: boolean;
  /** Obsazené intervaly (sloučené, seřazené), jen v rozsahu `range`. */
  busy: BusyInterval[];
  /** Čas poslední úspěšné synchronizace s e-chalupami (ISO 8601), nebo null. */
  updatedAt: string | null;
  /** Čas, kdy Worker stav vyhodnotil (ISO 8601). */
  checkedAt: string;
  /** Rozsah dat, pro který odpověď platí; mimo něj je obsazenost neznámá. */
  range: { from: IsoDate; to: IsoDate };
  /** Počet událostí v načteném exportu a kolik z nich nešlo spolehlivě převést (bez obsahu událostí). */
  source?: { events: number; skipped: number };
}
