import ICAL from 'ical.js';
import { addDays, isIsoDate, isoDateInZone, isoFromParts, TIME_ZONE, type IsoDate } from '../lib/availability/dates.ts';
import { mergeIntervals } from '../lib/availability/occupancy.ts';
import type { BusyInterval } from '../lib/availability/types.ts';
import { RESERVATION_CODE } from '../lib/booking/codes.ts';

/** Export není platný iCalendar – nesmí se vyložit jako prázdný kalendář. */
export class IcalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcalParseError';
  }
}

/** Export má víc událostí, než se bezpečně zpracuje – nesmí se vyložit jako (částečně) volno. */
export class IcalLimitError extends IcalParseError {
  constructor(message: string) {
    super(message);
    this.name = 'IcalLimitError';
  }
}

/** Nejvyšší počet VEVENT v exportu. Skutečný export chalupy jich má jednotky až desítky. */
export const MAX_EVENTS = 2000;

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

/**
 * Událost exportu převedená na obsazené noci. Kromě intervalu nese jen údaje potřebné
 * k rozpoznání vlastní rezervace vrácené exportem e-chalup (UID a kódy rezervace
 * z SUMMARY/DESCRIPTION), žádná jména ani kontakty. Do odpovědí API se nepředává.
 */
export interface CalendarEvent extends BusyInterval {
  uid: string | null;
  codes: string[];
}

export interface ParsedEvents {
  events: CalendarEvent[];
  /** Počet VEVENT v exportu. */
  total: number;
  skipped: number;
}

function reservationCodes(component: Component): string[] {
  const text = ['summary', 'description'].map((name) => String(component.getFirstPropertyValue(name) ?? '')).join('\n');
  return [...new Set(text.match(RESERVATION_CODE) ?? [])];
}

const isCancelled = (component: Component) => String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

/**
 * Načte obsazené intervaly z iCal exportu. Vrací jen data (žádná jména, popisy ani UID).
 * @throws IcalParseError pokud text není platný VCALENDAR
 */
export function parseBusyIntervals(text: string, range: { from: IsoDate; to: IsoDate }): ParsedCalendar {
  const { events, total, skipped } = parseCalendarEvents(text, range);
  return { busy: mergeIntervals(events.map(({ start, end }) => ({ start, end }))), events: total, skipped };
}

/**
 * Jednotlivé události exportu (nesloučené), oříznuté na rozsah. Slouží ke kontrole kolize při
 * vytváření rezervace a k rozpoznání vlastních rezervací v exportu.
 * @throws IcalParseError pokud text není platný VCALENDAR
 */
export function parseCalendarEvents(text: string, range: { from: IsoDate; to: IsoDate }): ParsedEvents {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new IcalParseError('Missing VCALENDAR');
  // Levná kontrola před parsováním, aby obří export nezahltil Worker.
  if ((text.match(/^BEGIN:VEVENT\s*$/gim)?.length ?? 0) > MAX_EVENTS) throw new IcalLimitError('Too many events');
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
  if (vevents.length > MAX_EVENTS) throw new IcalLimitError('Too many events');
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

  const found: CalendarEvent[] = [];
  const add = (event: Event, start: Time | null, end: Time | null) => {
    const nights = toNights(start, end);
    if (!nights) return false;
    const { interval } = nights;
    if (interval.end > range.from && interval.start < range.to) {
      found.push({
        start: interval.start < range.from ? range.from : interval.start,
        end: interval.end > range.to ? range.to : interval.end,
        uid: event.uid || null,
        codes: reservationCodes(event.component),
      });
    }
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
        if (!add(event, event.startDate, event.endDate)) skipped++;
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
        if (!add(details.item, details.startDate, details.endDate)) {
          skipped++;
          break;
        }
      }
    } catch {
      skipped++;
    }
  }

  return { events: found, total: vevents.length, skipped };
}
