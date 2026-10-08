import type { IsoDate } from '../../lib/availability/dates.ts';
import type { DayKind } from '../../lib/availability/occupancy.ts';
import type { StayError } from '../../lib/availability/stay.ts';

const asDate = (date: IsoDate) => new Date(`${date}T12:00:00Z`);
const inUtc = { timeZone: 'UTC' } as const;

const monthTitle = new Intl.DateTimeFormat('cs-CZ', { ...inUtc, month: 'long', year: 'numeric' });
const monthOnly = new Intl.DateTimeFormat('cs-CZ', { ...inUtc, month: 'long' });
const fullDate = new Intl.DateTimeFormat('cs-CZ', { ...inUtc, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Zkratky dnů v týdnu, pondělí první. */
export const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const formatMonth = (monthStart: IsoDate) => capitalize(monthTitle.format(asDate(monthStart)));
export const formatFullDate = (date: IsoDate) => fullDate.format(asDate(date));
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

/** Popisek zobrazeného období, např. „říjen – prosinec 2026“ nebo „prosinec 2026 – únor 2027“. */
export function formatRange(first: IsoDate, last: IsoDate): string {
  if (first === last) return monthTitle.format(asDate(first));
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${(sameYear ? monthOnly : monthTitle).format(asDate(first))} – ${monthTitle.format(asDate(last))}`;
}

export const DAY_STATUS: Record<DayKind | 'past', string> = {
  free: 'volno',
  busy: 'obsazeno',
  checkin: 'den příjezdu jiných hostů, lze zvolit jako den odjezdu',
  checkout: 'den odjezdu jiných hostů, lze zvolit jako den příjezdu',
  unknown: 'obsazenost není známá',
  past: 'minulé datum',
};

export const STAY_ERRORS: Record<StayError, string> = {
  past: 'Termín v minulosti nelze vybrat.',
  'arrival-busy': 'Tento den je obsazený. Vyberte prosím jiný den příjezdu.',
  'range-busy': 'Vybraný pobyt zasahuje do obsazeného termínu. Zvolte prosím dřívější odjezd nebo jiný příjezd.',
  unknown: 'Obsazenost pro tento termín teď neznáme. Ověřte ji prosím přímo na e-chalupy.cz.',
  order: 'Odjezd musí být alespoň den po příjezdu.',
  'no-arrival': 'Nejdříve vyberte datum příjezdu.',
};
