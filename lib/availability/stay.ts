import { MIN_NIGHTS } from '../booking/rules.ts';
import { diffDays, type IsoDate } from './dates.ts';
import type { Occupancy } from './occupancy.ts';

/**
 * Jediná logika výběru pobytu. Používá ji kliknutí do kalendáře i datumová pole,
 * aby obě cesty procházely stejnou validací dostupnosti.
 */
export interface Stay {
  arrival: IsoDate | null;
  departure: IsoDate | null;
}

export type StayError =
  | 'past'            // datum v minulosti
  | 'arrival-busy'    // noc po zvoleném dni příjezdu je obsazená
  | 'range-busy'      // pobyt zasahuje do obsazeného období
  | 'unknown'         // obsazenost pro zvolený termín není známá
  | 'order'           // odjezd není po příjezdu
  | 'too-short'       // pobyt kratší než MIN_NIGHTS (lib/booking/rules.ts)
  | 'no-arrival';     // odjezd bez příjezdu

export interface StayContext {
  today: IsoDate;
  /** null = obsazenost se načítá nebo není dostupná; výběr pak není možný. */
  occupancy: Occupancy | null;
}

export interface StayUpdate {
  stay: Stay;
  error: StayError | null;
}

export const EMPTY_STAY: Stay = { arrival: null, departure: null };

export function nights(stay: Stay): number {
  return stay.arrival && stay.departure ? diffDays(stay.arrival, stay.departure) : 0;
}

function arrivalError(day: IsoDate, ctx: StayContext): StayError | null {
  if (day < ctx.today) return 'past';
  if (!ctx.occupancy) return 'unknown';
  const night = ctx.occupancy.night(day);
  if (night === 'unknown') return 'unknown';
  return night === 'busy' ? 'arrival-busy' : null;
}

/** Ověří pobyt [arrival, departure): aspoň MIN_NIGHTS nocí, všechny noci známé a volné. */
export function rangeError(arrival: IsoDate, departure: IsoDate, ctx: StayContext): StayError | null {
  const first = arrivalError(arrival, ctx);
  if (first) return first;
  if (departure <= arrival) return 'order';
  if (diffDays(arrival, departure) < MIN_NIGHTS) return 'too-short';
  const blocked = ctx.occupancy!.firstBlockedNight(arrival, departure);
  if (!blocked) return null;
  return ctx.occupancy!.night(blocked) === 'unknown' ? 'unknown' : 'range-busy';
}

/** Kliknutí na den v kalendáři: první kliknutí příjezd, druhé odjezd. */
export function pickDay(stay: Stay, day: IsoDate, ctx: StayContext): StayUpdate {
  const choosingDeparture = stay.arrival !== null && stay.departure === null && day > stay.arrival;
  if (!choosingDeparture) {
    const error = arrivalError(day, ctx);
    return error ? { stay, error } : { stay: { arrival: day, departure: null }, error: null };
  }
  const error = rangeError(stay.arrival!, day, ctx);
  return error ? { stay, error } : { stay: { arrival: stay.arrival, departure: day }, error: null };
}

/** Změna data příjezdu z datumového pole. Neplatný odjezd se zruší. */
export function setArrival(stay: Stay, day: IsoDate | null, ctx: StayContext): StayUpdate {
  if (!day) return { stay: EMPTY_STAY, error: null };
  const error = arrivalError(day, ctx);
  if (error) return { stay, error };
  if (stay.departure && stay.departure > day) {
    const conflict = rangeError(day, stay.departure, ctx);
    if (!conflict) return { stay: { arrival: day, departure: stay.departure }, error: null };
    return { stay: { arrival: day, departure: null }, error: conflict };
  }
  return { stay: { arrival: day, departure: null }, error: null };
}

/** Změna data odjezdu z datumového pole. */
export function setDeparture(stay: Stay, day: IsoDate | null, ctx: StayContext): StayUpdate {
  if (!day) return { stay: { arrival: stay.arrival, departure: null }, error: null };
  if (!stay.arrival) return { stay, error: 'no-arrival' };
  const error = rangeError(stay.arrival, day, ctx);
  return error ? { stay, error } : { stay: { arrival: stay.arrival, departure: day }, error: null };
}
