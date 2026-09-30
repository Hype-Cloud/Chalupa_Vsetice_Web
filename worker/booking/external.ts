// Čerstvá kontrola termínu proti exportu e-chalup (e-chalupy zahrnují i Airbnb a Booking.com).

import type { IsoDate } from '../../lib/availability/dates.ts';
import { fetchExportText, UpstreamError, type AvailabilityDeps } from '../availability.ts';
import { IcalParseError, parseCalendarEvents, type CalendarEvent } from '../ical.ts';

/** Vlastní rezervace, jak ji lze poznat v exportu e-chalup. */
export interface OwnIdentity {
  icalUid: string;
  code: string;
}

export type ExternalCheck =
  | { ok: true }
  | { ok: false; reason: 'dates-unavailable' }
  /** Export nešel stáhnout nebo přečíst celý – o volnosti termínu nelze rozhodnout. */
  | { ok: false; reason: 'availability-check-failed' | 'availability-incomplete'; detail: string };

/**
 * Událost exportu je vlastní rezervace `own` vrácená zpět přes e-chalupy (import → export),
 * pokud nese stejné UID nebo veřejný kód rezervace v SUMMARY/DESCRIPTION. Podle samotných dat se
 * nerozhoduje: cizí rezervace se stejným termínem by se tím skryla.
 */
export function isOwnEcho(event: CalendarEvent, own: OwnIdentity): boolean {
  return event.uid === own.icalUid || event.codes.includes(own.code);
}

/**
 * První událost exportu, která koliduje s pobytem [arrival, departure). Událost, která je
 * ozvěnou kontrolované rezervace (`exclude`), se za kolizi nepovažuje; ozvěny jiných
 * vlastních rezervací ano – obsazují termín stejně jako cizí rezervace.
 */
export function findExternalConflict(stay: { arrival: IsoDate; departure: IsoDate }, events: readonly CalendarEvent[], exclude?: OwnIdentity): CalendarEvent | null {
  return events.find((event) => event.start < stay.departure && event.end > stay.arrival && !(exclude && isOwnEcho(event, exclude))) ?? null;
}

/**
 * Stáhne export e-chalup bez cache a ověří, že pobyt s ničím nekoliduje. Selhání stažení nebo
 * neúplný export (vynechané události) znamená odmítnutí, nikdy „volno“.
 */
export async function checkExternalAvailability(
  url: string,
  stay: { arrival: IsoDate; departure: IsoDate },
  deps: Pick<AvailabilityDeps, 'fetch'>,
  exclude?: OwnIdentity,
): Promise<ExternalCheck> {
  let text: string;
  try {
    text = await fetchExportText(url, deps);
  } catch (error) {
    return { ok: false, reason: 'availability-check-failed', detail: `upstream-${error instanceof UpstreamError ? error.kind : 'unknown'}` };
  }
  let parsed;
  try {
    parsed = parseCalendarEvents(text, { from: stay.arrival, to: stay.departure });
  } catch (error) {
    return { ok: false, reason: 'availability-check-failed', detail: error instanceof IcalParseError ? 'upstream-invalid-ical' : 'upstream-parse' };
  }
  // Nepřevedená událost může ležet právě v požadovaném termínu.
  if (parsed.skipped > 0) return { ok: false, reason: 'availability-incomplete', detail: 'skipped-events' };
  return findExternalConflict(stay, parsed.events, exclude) ? { ok: false, reason: 'dates-unavailable' } : { ok: true };
}
