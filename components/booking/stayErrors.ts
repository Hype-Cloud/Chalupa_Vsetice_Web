import type { DayKind } from '../../lib/availability/occupancy.ts';
import type { StayError } from '../../lib/availability/stay.ts';
import { MIN_NIGHTS } from '../../lib/booking/rules.ts';
import type { I18n, MessageKey } from '../../lib/i18n/index.ts';

// Technické kódy z validace výběru (lib/availability/stay.ts) → překladové klíče.
// Validace pracuje jen s kódy; text se volí až při zobrazení podle aktuálního jazyka.

export const STAY_ERROR_KEYS: Record<StayError, MessageKey> = {
  past: 'stayError.past',
  'arrival-busy': 'stayError.arrivalBusy',
  'range-busy': 'stayError.rangeBusy',
  unknown: 'stayError.unknown',
  order: 'stayError.order',
  'too-short': 'stayError.tooShort',
  'no-arrival': 'stayError.noArrival',
};

/** Hláška k chybě výběru v aktuálním jazyce (minimální délka pobytu vždy z MIN_NIGHTS). */
export const stayErrorMessage = (i18n: Pick<I18n, 't' | 'plural'>, error: StayError) =>
  i18n.t(STAY_ERROR_KEYS[error], { nights: i18n.plural('booking.nights', MIN_NIGHTS) });

/** Stav dne v kalendáři → popisek pro čtečky obrazovky. */
export const DAY_STATUS_KEYS: Record<DayKind | 'past', MessageKey> = {
  free: 'calendar.day.free',
  busy: 'calendar.day.busy',
  checkin: 'calendar.day.checkin',
  checkout: 'calendar.day.checkout',
  unknown: 'calendar.day.unknown',
  past: 'calendar.day.past',
};
