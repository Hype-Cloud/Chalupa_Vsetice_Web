// Kalendářní data jako řetězce YYYY-MM-DD (bez času). Aritmetika běží v UTC,
// takže nezávisí na časovém pásmu prohlížeče ani Workeru.

export type IsoDate = string;

/** Časové pásmo chalupy – určuje, který den je „dnes“ a kam patří časované události. */
export const TIME_ZONE = 'Europe/Prague';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isoFromParts(year: number, month: number, day: number): IsoDate {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year, month] = date.split('-').map(Number);
  return isoFromParts(year, month + months, 1);
}

/** Počet dní z `from` do `to` (kladný, pokud `to` je později). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Kalendářní datum okamžiku `instant` v zadaném časovém pásmu. */
export function isoDateInZone(instant: Date, timeZone: string = TIME_ZONE): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayInPrague(now: Date = new Date()): IsoDate {
  return isoDateInZone(now, TIME_ZONE);
}

/** První den měsíce, ve kterém leží `date`. */
export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/** Den v týdnu s pondělím jako 0. */
export function weekdayMondayFirst(date: IsoDate): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function daysInMonth(monthStart: IsoDate): number {
  const [year, month] = monthStart.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
