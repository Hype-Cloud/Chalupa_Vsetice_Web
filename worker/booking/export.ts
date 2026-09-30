// GET /api/reservations.ics?token=… – soukromý iCal feed vlastních rezervací pro import do e-chalup.
//
// - Zapnutý jen při BOOKING_ICAL_EXPORT_ENABLED = "true" (zatím jen Worker Previews); jinak 404.
// - Přístup přes neuhodnutelný token v query stringu. Query string je v logách a traces
//   Cloudflare Observability skrytý (observability.redact_query_string ve wrangler.jsonc);
//   token proto nesmí být v cestě URL. Kód Workeru token ani URL nikdy neloguje.
// - Chybný nebo chybějící token vrací 404, aby se existence feedu nedala ověřit.
// - Chyba databáze nebo nesoulad prostředí vrací 503 bez kalendáře: importér nesmí dostat
//   prázdný nebo neúplný VCALENDAR.
// - Zrušené rezervace zůstávají ve feedu jako STATUS:CANCELLED se stejným UID a vyšším SEQUENCE.

import { secretEquals } from '../secrets.ts';
import { databaseEnvironment, listExportReservations } from './db.ts';
import { buildCalendar } from './ics.ts';
import type { BookingEnv } from './handler.ts';

export interface ExportEnv extends Pick<BookingEnv, 'DB' | 'BOOKING_ENV'> {
  /** "true" zapne export. V produkci zatím nenastaveno. */
  BOOKING_ICAL_EXPORT_ENABLED?: string;
  /** Secret: přístupový token feedu (min. 32 znaků). */
  BOOKING_ICAL_EXPORT_TOKEN?: string;
}

export interface ExportDeps {
  log: (message: string) => void;
}

/** Kratší token se nepovažuje za bezpečný – export se bez něj nespustí. */
export const MIN_TOKEN_LENGTH = 32;

const HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS, ...extra } });

export async function handleIcalExport(request: Request, env: ExportEnv, deps: ExportDeps): Promise<Response> {
  if (env.BOOKING_ICAL_EXPORT_ENABLED !== 'true') return plain(404, 'Not found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });

  const token = env.BOOKING_ICAL_EXPORT_TOKEN?.trim() ?? '';
  if (token.length < MIN_TOKEN_LENGTH || !env.DB || !env.BOOKING_ENV) {
    deps.log('ical-export: not configured');
    return plain(503, 'Service unavailable');
  }
  const presented = new URL(request.url).searchParams.get('token') ?? '';
  if (!(await secretEquals(presented, token))) {
    deps.log('ical-export: unauthorized');
    return plain(404, 'Not found');
  }

  let body: string;
  try {
    // Pojistka proti záměně databází: export Preview nesmí číst produkční D1 ani naopak.
    if ((await databaseEnvironment(env.DB)) !== env.BOOKING_ENV) {
      deps.log('ical-export: database environment mismatch');
      return plain(503, 'Service unavailable');
    }
    const reservations = await listExportReservations(env.DB);
    body = buildCalendar(reservations, { test: env.BOOKING_ENV !== 'production' });
    deps.log(`ical-export: served (${reservations.length} events)`);
  } catch {
    // Žádný částečný kalendář. Do logu jde jen druh chyby.
    deps.log('ical-export: failed');
    return plain(503, 'Service unavailable');
  }

  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="chalupa-vsetice-rezervace.ics"',
      ...HEADERS,
    },
  });
}
