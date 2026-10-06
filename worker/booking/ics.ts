// Výstupní iCalendar (RFC 5545) s vlastními rezervacemi z D1 pro import do e-chalup.
// Obsahuje jen rezervace z D1 – nikdy události z exportu e-chalup (žádná synchronizační smyčka).

import { isIsoDate } from '../../lib/availability/dates.ts';
import type { ExportReservation } from './db.ts';

const CRLF = '\r\n';
const MAX_OCTETS = 75;

/** Escapování hodnoty typu TEXT (RFC 5545, 3.3.11): \ ; , a konce řádků. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Zalomení řádku na nejvýš 75 oktetů (RFC 5545, 3.1). Pokračovací řádky začínají mezerou.
 * Láme se jen mezi znaky, vícebajtové znaky UTF-8 (čeština) se nerozdělí.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1; // úvodní mezera pokračovacího řádku
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** YYYY-MM-DD → YYYYMMDD (hodnota typu DATE). */
function icsDate(date: string): string {
  if (!isIsoDate(date)) throw new Error('invalid-date');
  return date.replace(/-/g, '');
}

/** ISO 8601 čas → YYYYMMDDTHHMMSSZ (UTC). */
function icsUtc(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) throw new Error('invalid-timestamp');
  return time.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const formatCzk = (value: number) => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Kč`;

const PAYMENT_STATUS: Record<Exclude<ExportReservation['status'], 'cancelled'>, string> = {
  pending_payment: 'čeká na platbu (ověřit ručně)',
  paid: 'zaplaceno',
};

export interface CalendarOptions {
  /** Mimo produkci se každá událost označí jako TEST, aby se omylem nepoužila v provozu. */
  test: boolean;
}

/** Společné vlastnosti aktivní i zrušené události (stejné UID, termín a aktuální SEQUENCE). */
function identityLines(r: ExportReservation): string[] {
  if (!(r.departure > r.arrival)) throw new Error('invalid-range');
  return [
    `UID:${escapeText(r.icalUid)}`,
    // DTSTAMP/LAST-MODIFIED = poslední změna rezervace: nezměněná rezervace dává stále stejný text.
    `DTSTAMP:${icsUtc(r.updatedAt)}`,
    `CREATED:${icsUtc(r.createdAt)}`,
    `LAST-MODIFIED:${icsUtc(r.updatedAt)}`,
    `SEQUENCE:${r.icalSequence}`,
    // Celodenní události: DTEND je exkluzivní (den odjezdu), bez časového pásma.
    `DTSTART;VALUE=DATE:${icsDate(r.arrival)}`,
    `DTEND;VALUE=DATE:${icsDate(r.departure)}`,
  ];
}

/**
 * Zrušená rezervace zůstává ve feedu jako „tombstone“: stejné UID, vyšší SEQUENCE (zvýší ho
 * cancelReservation) a STATUS:CANCELLED. E-chalupy podle ověřeného chování rezervaci zruší jen
 * takto – pouhé vynechání události ji nezruší. Bez osobních a platebních údajů.
 */
function cancelledLines(r: ExportReservation, options: CalendarOptions): string[] {
  const prefix = options.test ? '[TEST] ' : '';
  return [
    'BEGIN:VEVENT',
    ...identityLines(r),
    `SUMMARY:${escapeText(`${prefix}ZRUŠENO – Web ${r.code}`)}`,
    `DESCRIPTION:${escapeText(`${prefix}Rezervace z webu ${r.code} byla zrušena.`)}`,
    'STATUS:CANCELLED',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
}

function eventLines(r: ExportReservation, options: CalendarOptions): string[] {
  if (r.status === 'cancelled') return cancelledLines(r, options);
  const prefix = options.test ? '[TEST] ' : '';
  const guest = `${r.firstName} ${r.lastName}`;
  const description = [
    `${prefix}REZERVACE Z WEBU chalupavsetice.cz`,
    `Kód rezervace: ${r.code}`,
    `Host: ${guest}`,
    `Telefon: ${r.phone}`,
    `E-mail: ${r.email}`,
    `Počet hostů: ${r.guests}`,
    `Cena: ${formatCzk(r.priceCzk)}`,
    `Variabilní symbol: ${r.variableSymbol}`,
    `Stav platby: ${PAYMENT_STATUS[r.status]}`,
    // Poznámka hosta je volný text: escapeText níže z ní udělá jednu hodnotu DESCRIPTION
    // (\ ; , a konce řádků), takže nemůže přidat vlastní vlastnost ani VEVENT.
    ...(r.note ? ['', 'Poznámka hosta:', r.note] : []),
  ].join('\n');
  return [
    'BEGIN:VEVENT',
    ...identityLines(r),
    `SUMMARY:${escapeText(`${prefix}Web ${r.code} – ${guest}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ];
}

/**
 * Celý kalendář. Při neplatném záznamu vyhodí chybu – raději žádný výstup než kalendář,
 * ve kterém by rezervace chyběla (importér by ji zrušil).
 */
export function buildCalendar(reservations: readonly ExportReservation[], options: CalendarOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Chalupa Všetice//Rezervace z webu//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${options.test ? '[TEST] ' : ''}Chalupa Všetice – rezervace z webu`)}`,
    ...reservations.flatMap((r) => eventLines(r, options)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
