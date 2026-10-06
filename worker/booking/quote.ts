// POST /api/quote – autoritativní cena pobytu ze serveru (stejný výpočet jako rezervace).
//
// Jen čte ceník z D1, nic nezapisuje a neověřuje dostupnost (tu řeší GET /api/availability).
// Neobsahuje osobní údaje; chyby nevracejí detaily databáze. Neplatná ceníková data = 503
// pricing-unavailable (fail-closed), nikdy cena podle tichého fallbacku.

import { todayInPrague } from '../../lib/availability/dates.ts';
import { json } from '../http.ts';
import { PricingDataError, quoteStay } from './pricing.ts';
import { validateStay } from './validation.ts';

export interface QuoteEnv {
  DB?: D1Database;
}

export interface QuoteDeps {
  now: () => Date;
  log: (message: string) => void;
}

const MAX_BODY_BYTES = 2 * 1024;
const failure = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit) =>
  json({ error, ...extra }, { status, cacheControl: 'no-store', headers });

export async function handleQuote(request: Request, env: QuoteEnv, deps: QuoteDeps): Promise<Response> {
  try {
    if (request.method !== 'POST') return failure(405, 'method-not-allowed', {}, { allow: 'POST' });
    if (!env.DB) {
      deps.log('quote: not configured');
      return failure(503, 'not-configured');
    }
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return failure(415, 'unsupported-media-type');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return failure(413, 'payload-too-large');
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return failure(413, 'payload-too-large');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return failure(400, 'invalid-json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(422, 'invalid-request', { fields: ['body'] });

    const stay = validateStay(body as Record<string, unknown>, todayInPrague(deps.now()), { arrival: 'arrivalDate', departure: 'departureDate', guests: 'guests' });
    if (!stay.ok) return failure(422, 'invalid-request', { fields: stay.fields });

    try {
      return json(await quoteStay(env.DB, stay.value), { cacheControl: 'no-store' });
    } catch (error) {
      if (error instanceof PricingDataError) {
        deps.log('quote: pricing data invalid');
        return failure(503, 'pricing-unavailable');
      }
      deps.log('quote: database error');
      return failure(503, 'database-error');
    }
  } catch {
    deps.log('quote: internal error');
    return failure(500, 'internal-error');
  }
}
