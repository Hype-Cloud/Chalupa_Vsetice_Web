import ICAL from 'ical.js';
import { addDays, isIsoDate, isoDateInZone, isoFromParts, TIME_ZONE, type IsoDate } from '../lib/availability/dates.ts';
import { mergeIntervals } from '../lib/availability/occupancy.ts';
import type { BusyInterval } from '../lib/availability/types.ts';

/** Export není platný iCalendar – nesmí se vyložit jako prázdný kalendář. */
export class IcalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcalParseError';
  }
}

export interface ParsedCalendar {
  /** Obsazené noci [start, end), sloučené a oříznuté na požadovaný rozsah. */
  busy: BusyInterval[];
  /** Počet událostí VEVENT v exportu. */
  events: number;
  /**
   * Počet událostí, které nešlo spolehlivě převést (chybějící nebo neplatná data, konec před
   * začátkem). Nenulová hodnota znamená, že obsazenost nemusí být úplná.
   */
  skipped: number;
}

// Datum bez VALUE=DATE (např. „DTSTART:20261002“ jako v nápovědě e-chalup) je podle RFC 5545
// neplatné a ical.js ho odmítne; doplníme VALUE=DATE, aby se událost neztratila.
const BARE_DATE = /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)(?![^:\r\n]*VALUE=)((?:;[^:\r\n]*)?):(\d{8}(?:,\d{8})*)(\r?)$/gim;

// Pojistka proti nekonečným nebo extrémně hustým RRULE.
const MAX_OCCURRENCES = 1000;

type Time = InstanceType<typeof ICAL.Time>;
type Event = InstanceType<typeof ICAL.Event>;
type Component = InstanceType<typeof ICAL.Component>;

function toIsoDate(time: Time): IsoDate | null {
  const zone = time.zone?.tzid;
  if (time.isDate || !zone || zone === 'floating') {
    // Celodenní událost, plovoucí čas (bez Z a TZID) nebo TZID bez definice VTIMEZONE:
    // hodnota je místní čas chalupy, datum se bere přímo z ní bez převodu přes UTC.
    const iso = isoFromParts(time.year, time.month, time.day);
    return isIsoDate(iso) ? iso : null;
  }
  // UTC nebo pásmo definované ve VTIMEZONE: přepočet na datum v Europe/Prague.
  const instant = time.toJSDate();
  return Number.isNaN(instant.getTime()) ? null : isoDateInZone(instant, TIME_ZONE);
}

/**
 * Převede začátek a konec události na obsazené noci [start, end).
 * `suspicious` = konec před začátkem nebo neplatný konec: noc začátku se konzervativně
 * blokuje, ale událost se počítá mezi problémové.
 */
function toNights(start: Time | null, end: Time | null): { interval: BusyInterval; suspicious: boolean } | null {
  if (!start) return null;
  const from = toIsoDate(start);
  if (!from) return null;
  const to = end ? toIsoDate(end) : null;
  if (to && to > from) return { interval: { start: from, end: to }, suspicious: false };
  // Bez DTEND/DURATION (RFC 5545: celodenní událost = 1 den) nebo s koncem ve stejný den
  // (časovaná událost v rámci dne) se blokuje jedna noc; konec před začátkem je chyba dat.
  const invalidEnd = (end && !to) || (to !== null && to < from);
  return { interval: { start: from, end: addDays(from, 1) }, suspicious: !!invalidEnd };
}

const isCancelled = (component: Component) => String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

/**
 * Načte obsazené intervaly z iCal exportu. Vrací jen data (žádná jména, popisy ani UID).
 * @throws IcalParseError pokud text není platný VCALENDAR
 */
export function parseBusyIntervals(text: string, range: { from: IsoDate; to: IsoDate }): ParsedCalendar {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new IcalParseError('Missing VCALENDAR');
  let root: Component;
  try {
    root = new ICAL.Component(ICAL.parse(text.replace(BARE_DATE, '$1$2;VALUE=DATE:$3$4')) as unknown[]);
  } catch {
    throw new IcalParseError('Unparseable iCalendar data');
  }
  if (root.name !== 'vcalendar') throw new IcalParseError('Root component is not VCALENDAR');

  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(vtimezone);
    } catch {
      // Neplatná definice pásma: časy s TZID se pak vyhodnotí jako plovoucí.
    }
  }

  const vevents = root.getAllSubcomponents('vevent');
  const events: Event[] = [];
  const exceptions: Event[] = [];
  let skipped = 0;

  for (const vevent of vevents) {
    try {
      const event = new ICAL.Event(vevent);
      (vevent.hasProperty('recurrence-id') ? exceptions : events).push(event);
    } catch {
      skipped++;
    }
  }
  // Podle UID se párují jen výjimky (RECURRENCE-ID) s opakovanou událostí. Samostatné události
  // se stejným UID zůstávají samostatné, aby se žádná rezervace neztratila.
  const recurringByUid = new Map<string, Event>();
  for (const event of events) {
    try {
      if (event.uid && event.isRecurring() && !recurringByUid.has(event.uid)) recurringByUid.set(event.uid, event);
    } catch {
      // Neplatné RRULE se projeví při vyhodnocení události níže.
    }
  }
  for (const exception of exceptions) {
    const master = recurringByUid.get(exception.uid);
    if (master) master.relateException(exception);
    else events.push(exception); // výjimka bez opakované události: vyhodnotí se samostatně
  }

  const intervals: BusyInterval[] = [];
  const add = (start: Time | null, end: Time | null) => {
    const nights = toNights(start, end);
    if (!nights) return false;
    const { interval } = nights;
    if (interval.end > range.from && interval.start < range.to) intervals.push(interval);
    return !nights.suspicious;
  };

  for (const event of events) {
    try {
      if (!event.component.hasProperty('dtstart')) {
        skipped++;
        continue;
      }
      if (isCancelled(event.component)) continue;
      if (!event.isRecurring()) {
        if (!add(event.startDate, event.endDate)) skipped++;
        continue;
      }
      const iterator = event.iterator();
      for (let i = 0; i < MAX_OCCURRENCES; i++) {
        const next = iterator.next();
        if (!next) break;
        const details = event.getOccurrenceDetails(next);
        const startIso = toIsoDate(details.startDate);
        if (startIso && startIso >= range.to) break;
        if (isCancelled(details.item.component)) continue;
        if (!add(details.startDate, details.endDate)) {
          skipped++;
          break;
        }
      }
    } catch {
      skipped++;
    }
  }

  const clipped = intervals.map((i) => ({ start: i.start < range.from ? range.from : i.start, end: i.end > range.to ? range.to : i.end }));
  return { busy: mergeIntervals(clipped), events: vevents.length, skipped };
}
