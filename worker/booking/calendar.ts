// Odkaz „přidat do kalendáře“: GET /calendar/<token> – jedna událost celého pobytu.
//
// - URL je bez přípony `.ics`: iOS (Apple Mail) odkaz končící `.ics` nabízí jako odběr kalendáře,
//   ne jako jednorázovou událost. Cesta s `.ics` zůstává funkční (dříve odeslané odkazy).
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
/** `/calendar/<token>` (aktuální tvar) i `/calendar/<token>.ics` (dříve odeslané odkazy). */
const CALENDAR_PATH = /^\/calendar\/([^/.]+)(?:\.ics)?$/;

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
  return token && CALENDAR_TOKEN.test(token) ? `${origin}/calendar/${token}` : null;
}

export const isCalendarPath = (pathname: string) => pathname.startsWith('/calendar/');

const utc = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Pobyt pro událost – jen to, co do kalendáře patří. */
export interface CalendarStay {
  arrival: IsoDate;
  departure: IsoDate;
  locale: string | null;
}

interface EventOptions {
  method: CalendarMethod;
  dtstamp: Date;
  /** Další vlastnosti VEVENT (SEQUENCE, STATUS, ORGANIZER, ATTENDEE) – už složené řádky. */
  extra?: string[];
  /** Věta připojená k popisu (pozvánka REQUEST). */
  note?: 'calendarEvent.inviteNote';
}

/** Společné řádky VCALENDAR s jednou událostí pobytu (odkaz i PoC pozvánky v e-mailu). */
async function stayCalendar(stay: CalendarStay, token: string, options: EventOptions): Promise<string> {
  const business = businessIdentity();
  const i18n = createI18n(isLocale(stay.locale) ? stay.locale : undefined);
  const uidHash = Array.from(await sha256(`calendar:${token}`), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const description = [i18n.t('calendarEvent.description', { checkIn: STAY_TIMES.checkIn, checkOut: STAY_TIMES.checkOut }), ...(options.note ? [i18n.t(options.note)] : [])].join(' ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(`-//${business.name}//Pobyt//CS`)}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${options.method}`,
    'BEGIN:VEVENT',
    `UID:pobyt-${uidHash}@${new URL(business.websiteUrl).hostname}`,
    `DTSTAMP:${utc(options.dtstamp)}`,
    `DTSTART:${utc(zonedDateTime(stay.arrival, STAY_TIMES.checkIn, STAY_TIMES.timeZone))}`,
    `DTEND:${utc(zonedDateTime(stay.departure, STAY_TIMES.checkOut, STAY_TIMES.timeZone))}`,
    `SUMMARY:${escapeText(i18n.t('calendarEvent.summary', { name: business.name }))}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${business.websiteUrl}`,
    'TRANSP:OPAQUE',
    ...(options.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** ICS s jednou událostí pobytu pro odkaz (CRLF, skládání řádků po 75 oktetech). UID z otisku tokenu. */
export function buildStayCalendar(stay: CalendarStay, token: string, now: Date): Promise<string> {
  return stayCalendar(stay, token, { method: 'PUBLISH', dtstamp: now });
}

// --- Preview PoC: kalendářová část v potvrzovacím e-mailu (CALENDAR_INVITE_POC) -----------------
//
// Jen pro ověření chování e-mailových klientů v Preview; produkce kalendářové přílohy neposílá
// (gate v confirmation.ts). Stejné UID jako odkaz → import přes odkaz i z e-mailu je jedna událost.
// - PUBLISH: jednorázová událost bez ORGANIZER a ATTENDEE (obsahem shodná s odkazem + SEQUENCE/STATUS).
// - REQUEST: iTIP pozvánka; ORGANIZER = veřejný e-mail rezervací (shodný s odesílatelem),
//   ATTENDEE = jen adresa příjemce e-mailu (v Preview testovací schránka), RSVP=FALSE.
//   Odpověď (REPLY) systém nezpracovává – stav rezervace se nemění.
// - DTSTAMP z created_at (replay dává stejné ICS), SEQUENCE:0, STATUS podle stavu rezervace.
//   Změny, potvrzení platby ani zrušení (METHOD:CANCEL, vyšší SEQUENCE) PoC neřeší.

export type CalendarMethod = 'PUBLISH' | 'REQUEST';

export interface StayInvite {
  method: CalendarMethod;
  status: 'pending_payment' | 'paid';
  /** reservations.created_at (ISO) – DTSTAMP stabilní při replayi. */
  createdAt: string;
  /** REQUEST: adresa příjemce e-mailu. */
  attendee?: string;
}

/** Jednoduchá adresa bez znaků, které by rozbily vlastnost iCalendar (`;`, `:`, `,`, `"`, mezery, řídicí znaky). */
const PLAIN_EMAIL = /^[^\s@";:,<>\\]+@[^\s@";:,<>\\]+\.[^\s@";:,<>\\]+$/;

/** MIME typ kalendářové části – parametr method se musí shodovat s METHOD uvnitř ICS (RFC 6047). */
export const inviteContentType = (method: CalendarMethod) => `text/calendar; charset=utf-8; method=${method}`;

/** ICS kalendářové části e-mailu (PoC). @throws Error při neplatném vstupu (volající přílohu vynechá). */
export async function buildStayInvite(stay: CalendarStay, token: string, invite: StayInvite): Promise<string> {
  const dtstamp = new Date(invite.createdAt);
  if (!CALENDAR_TOKEN.test(token) || Number.isNaN(dtstamp.getTime())) throw new Error('invalid-invite');
  const extra = ['SEQUENCE:0', `STATUS:${invite.status === 'paid' ? 'CONFIRMED' : 'TENTATIVE'}`];
  if (invite.method === 'REQUEST') {
    const attendee = invite.attendee?.trim() ?? '';
    if (!PLAIN_EMAIL.test(attendee)) throw new Error('invalid-invite');
    const business = businessIdentity();
    extra.push(
      `ORGANIZER;CN="${business.name.replace(/["\\]/g, '')}":mailto:${business.emailReservations}`,
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${attendee}`,
    );
  }
  return stayCalendar(stay, token, { method: invite.method, dtstamp, extra, ...(invite.method === 'REQUEST' ? { note: 'calendarEvent.inviteNote' as const } : {}) });
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
