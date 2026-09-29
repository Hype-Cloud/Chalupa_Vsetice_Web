import { addDays, type IsoDate } from './dates.ts';
import type { AvailabilityResponse, BusyInterval } from './types.ts';

/** Seřadí intervaly a sloučí překrývající se i na sebe navazující (end === další start). */
export function mergeIntervals(intervals: readonly BusyInterval[]): BusyInterval[] {
  const sorted = intervals.filter((i) => i.start < i.end).map((i) => ({ ...i })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

export type NightState = 'free' | 'busy' | 'unknown';

/**
 * Stav dne z pohledu hosta, odvozený ze dvou nocí (předchozí a následující):
 * - free: obě noci volné
 * - busy: obě noci obsazené
 * - checkin: noc před dnem volná, noc po něm obsazená → den příjezdu jiných hostů
 * - checkout: noc před dnem obsazená, noc po něm volná → den odjezdu jiných hostů
 * - unknown: obsazenost není známá
 */
export type DayKind = 'free' | 'busy' | 'checkin' | 'checkout' | 'unknown';

export class Occupancy {
  private readonly intervals: BusyInterval[];
  /** Rozsah, pro který jsou data známá; noci mimo něj jsou `unknown`. */
  private readonly range: { from: IsoDate; to: IsoDate } | null;
  /**
   * false = seznam obsazených intervalů nemusí být úplný (status `partial`): známé obsazené
   * noci zůstávají `busy`, ale ostatní noci jsou `unknown`, ne volné.
   */
  private readonly freeIsKnown: boolean;

  constructor(busy: readonly BusyInterval[], range: { from: IsoDate; to: IsoDate } | null, options: { freeIsKnown?: boolean } = {}) {
    this.intervals = mergeIntervals(busy);
    this.range = range;
    this.freeIsKnown = options.freeIsKnown ?? true;
  }

  /** Stav noci začínající dnem `date`. */
  night(date: IsoDate): NightState {
    if (!this.range || date < this.range.from || date >= this.range.to) return 'unknown';
    let lo = 0;
    let hi = this.intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const interval = this.intervals[mid];
      if (date < interval.start) hi = mid - 1;
      else if (date >= interval.end) lo = mid + 1;
      else return 'busy';
    }
    return this.freeIsKnown ? 'free' : 'unknown';
  }

  day(date: IsoDate): DayKind {
    const before = this.night(addDays(date, -1));
    const after = this.night(date);
    if (after === 'unknown') return 'unknown';
    if (before === 'unknown') return after === 'busy' ? 'busy' : 'free';
    if (before === 'busy') return after === 'busy' ? 'busy' : 'checkout';
    return after === 'busy' ? 'checkin' : 'free';
  }

  /** První obsazená nebo neznámá noc v rozsahu [from, to), jinak null. */
  firstBlockedNight(from: IsoDate, to: IsoDate): IsoDate | null {
    for (let date = from; date < to; date = addDays(date, 1)) {
      if (this.night(date) !== 'free') return date;
    }
    return null;
  }
}

/**
 * Obsazenost pro výběr pobytu podle odpovědi API:
 * - `ok`, `stale`: úplný seznam obsazených intervalů (stale s upozorněním na stáří dat),
 * - `partial`: export nešel převést celý, známé obsazené noci se zobrazí, ostatní jsou neznámé
 *   a výběr pobytu je tím zablokovaný,
 * - `unavailable`: nic není známo.
 */
export function occupancyFromResponse(data: AvailabilityResponse): Occupancy | null {
  if (data.status === 'unavailable') return null;
  return new Occupancy(data.busy, data.range, { freeIsKnown: data.status !== 'partial' });
}
