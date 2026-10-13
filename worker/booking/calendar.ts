// Odkaz „přidat do kalendáře“: GET /calendar/<token>.ics – jedna událost celého pobytu.
//
// - Token (reservations.calendar_token, migrace 0010) je capability: 32 kryptograficky
//   náhodných bajtů v base64url, oddělený od interního id, veřejného kódu i VS. Kdo zná odkaz,
//   stáhne událost – proto obsahuje jen termín pobytu a název (žádné jméno, kontakty, poznámku,
//   cenu, platební údaje ani interní id). Token ani URL se nelogují.
// - calendarUrl skládá jen server (calendarUrl()); stejnou hodnotu dostává odpověď API
//   (success summary na webu) i potvrzovací e-mail.
// - Událost: příjezd v STAY_TIMES.checkIn → odjezd v STAY_TIMES.checkOut, místní čas pásma
//   STAY_TIMES.timeZone převedený na UTC (správně i přes přechod letního/zimního času).
// - Neplatný formát tokenu → 404 bez dotazu do D1. Neznámý token i zrušená rezervace → 404
//   (zrušení se navenek neliší od neexistujícího odkazu). pending_payment i paid → událost.
// - Žádné úložiště souborů: ICS se generuje při každém požadavku.
// - Content-Disposition: inline (Safari na iOS nabídne přidání události přímo, ostatní prohlížeče
//   soubor stáhnou); filename zůstává, aby se stažený soubor nejmenoval podle tokenu.

import { zonedDateTime, type IsoDate } from '../../lib/availability/dates.ts';
import { STAY_TIMES } from '../../lib/booking/rules.ts';
import { businessIdentity } from '../../lib/business.ts';
import { createI18n, isLocale } from '../../lib/i18n/index.ts';
import { json } from '../http.ts';
import { sha256 } from '../secrets.ts';
import { escapeText, foldLine } from './ics.ts';

/** Token: 43 znaků base64url (32 bajtů). */
export const CALENDAR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALENDAR_PATH = /^\/calendar\/([^/]+)\.ics$/;

const CRLF = '\r\n';
const HEADERS = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Nový token (32 bajtů z CSPRNG). */
export function newCalendarToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Origin odkazu: v produkci vždy hlavní web (BUSINESS_WEBSITE_URL), nikdy workers.dev;
 * jinde (Preview) origin požadavku, aby šel odkaz otestovat proti Preview Workeru.
 */
export function calendarOrigin(bookingEnv: string | undefined, requestUrl: string): string {
  return bookingEnv === 'production' ? new URL(businessIdentity().websiteUrl).origin : new URL(requestUrl).origin;
}

/** Hotová URL pro API a e-mail; rezervace bez tokenu (před migrací 0010) → null. */
export function calendarUrl(origin: string, token: string | null): string | null {
  return token && CALENDAR_TOKEN.test(token) ? `${origin}/calendar/${token}.ics` : null;
}

export const isCalendarPath = (pathname: string) => pathname.startsWith('/calendar/');

const utc = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Pobyt pro událost – jen to, co do kalendáře patří. */
export interface CalendarStay {
  arrival: IsoDate;
  departure: IsoDate;
  locale: string | null;
}

/** ICS s jednou událostí pobytu (CRLF, skládání řádků po 75 oktetech). UID z otisku tokenu. */
export async function buildStayCalendar(stay: CalendarStay, token: string, now: Date): Promise<string> {
  const business = businessIdentity();
  const i18n = createI18n(isLocale(stay.locale) ? stay.locale : undefined);
  const uidHash = Array.from(await sha256(`calendar:${token}`), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(`-//${business.name}//Pobyt//CS`)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:pobyt-${uidHash}@${new URL(business.websiteUrl).hostname}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(zonedDateTime(stay.arrival, STAY_TIMES.checkIn, STAY_TIMES.timeZone))}`,
    `DTEND:${utc(zonedDateTime(stay.departure, STAY_TIMES.checkOut, STAY_TIMES.timeZone))}`,
    `SUMMARY:${escapeText(i18n.t('calendarEvent.summary', { name: business.name }))}`,
    `DESCRIPTION:${escapeText(i18n.t('calendarEvent.description', { checkIn: STAY_TIMES.checkIn, checkOut: STAY_TIMES.checkOut }))}`,
    `URL:${business.websiteUrl}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

export interface CalendarEnv {
  DB?: D1Database;
}

const notFound = () => json({ error: 'not-found' }, { status: 404, cacheControl: HEADERS['cache-control'], headers: { 'x-robots-tag': HEADERS['x-robots-tag'] } });

export async function handleCalendar(request: Request, env: CalendarEnv, deps: { now: () => Date; log: (message: string) => void }): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method-not-allowed' }, { status: 405, cacheControl: HEADERS['cache-control'], headers: { allow: 'GET, HEAD', 'x-robots-tag': HEADERS['x-robots-tag'] } });
  }
  // Formát tokenu se ověří před dotazem do databáze.
  const token = CALENDAR_PATH.exec(new URL(request.url).pathname)?.[1];
  if (!token || !CALENDAR_TOKEN.test(token)) return notFound();
  if (!env.DB) {
    deps.log('calendar: not configured');
    return json({ error: 'not-configured' }, { status: 503, cacheControl: HEADERS['cache-control'], headers: { 'x-robots-tag': HEADERS['x-robots-tag'] } });
  }
  try {
    const row = await env.DB.prepare(`SELECT arrival, departure, status, locale FROM reservations WHERE calendar_token = ?1`)
      .bind(token)
      .first<{ arrival: string; departure: string; status: string; locale: string | null }>();
    if (!row || (row.status !== 'pending_payment' && row.status !== 'paid')) return notFound();
    const body = await buildStayCalendar(row, token, deps.now());
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="pobyt.ics"', ...HEADERS },
    });
  } catch {
    // Do logu jen druh chyby – nikdy token ani URL.
    deps.log('calendar: database error');
    return json({ error: 'database-error' }, { status: 503, cacheControl: HEADERS['cache-control'], headers: { 'x-robots-tag': HEADERS['x-robots-tag'] } });
  }
}
