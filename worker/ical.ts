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
  /** Počet událostí vynechaných kvůli chybějícím nebo neplatným datům. */
  skipped: number;
}

// Pojistka proti nekonečným nebo extrémně hustým RRULE.
const MAX_OCCURRENCES = 1000;

type Time = InstanceType<typeof ICAL.Time>;
type Event = InstanceType<typeof ICAL.Event>;
type Component = InstanceType<typeof ICAL.Component>;

function toIsoDate(time: Time): IsoDate | null {
  if (time.isDate) {
    const iso = isoFromParts(time.year, time.month, time.day);
    return isIsoDate(iso) ? iso : null;
  }
  // Časovaná událost: den určuje místní čas chalupy (Europe/Prague).
  const instant = time.toJSDate();
  return Number.isNaN(instant.getTime()) ? null : isoDateInZone(instant, TIME_ZONE);
}

/** Převede začátek a konec události na obsazené noci [start, end). */
function toNights(start: Time | null, end: Time | null): BusyInterval | null {
  if (!start) return null;
  const from = toIsoDate(start);
  if (!from) return null;
  let to = end ? toIsoDate(end) : null;
  // Bez DTEND/DURATION nebo s koncem ve stejný den: RFC 5545 u celodenní události
  // počítá s jedním dnem; časovanou událost konzervativně bereme jako obsazenou noc.
  if (!to || to <= from) to = addDays(from, 1);
  return { start: from, end: to };
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
    root = new ICAL.Component(ICAL.parse(text) as unknown[]);
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

  const masters = new Map<string, Event>();
  const standalone: Event[] = [];
  const exceptions: Event[] = [];
  let skipped = 0;

  for (const vevent of root.getAllSubcomponents('vevent')) {
    let event: Event;
    try {
      event = new ICAL.Event(vevent);
    } catch {
      skipped++;
      continue;
    }
    if (vevent.hasProperty('recurrence-id')) exceptions.push(event);
    else if (event.uid) masters.set(event.uid, event);
    else standalone.push(event);
  }
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master) master.relateException(exception);
    else standalone.push(exception); // výjimka bez hlavní události: vyhodnotí se samostatně
  }

  const intervals: BusyInterval[] = [];
  const add = (start: Time | null, end: Time | null) => {
    const interval = toNights(start, end);
    if (!interval) skipped++;
    else if (interval.end > range.from && interval.start < range.to) intervals.push(interval);
  };

  for (const event of [...masters.values(), ...standalone]) {
    try {
      if (!event.component.hasProperty('dtstart')) {
        skipped++;
        continue;
      }
      if (isCancelled(event.component)) continue;
      if (!event.isRecurring()) {
        add(event.startDate, event.endDate);
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
        add(details.startDate, details.endDate);
      }
    } catch {
      skipped++;
    }
  }

  const clipped = intervals.map((i) => ({ start: i.start < range.from ? range.from : i.start, end: i.end > range.to ? range.to : i.end }));
  return { busy: mergeIntervals(clipped), skipped };
}
