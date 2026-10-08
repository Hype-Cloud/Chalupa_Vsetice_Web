// Smoke test veřejných endpointů po nasazení. Jen čtení a požadavky, které nic nezapíšou:
// nepoužívá žádné tokeny ani secrets, rezervační POST posílá bez údajů (nikdy nevznikne rezervace).

import { addDays, todayInPrague } from '../../lib/availability/dates.ts';

export type SmokeEnv = 'production' | 'preview';

export interface SmokeCheck {
  name: string;
  ok: boolean;
  /** Krátký popis bez obsahu odpovědí. */
  detail?: string;
  /** Varování nezpůsobí selhání (např. starší data z e-chalup). */
  warning?: boolean;
}

/**
 * Ověří základní URL: https (http jen pro localhost), bez přihlašovacích údajů, cesty, query
 * a fragmentu – aby se do smoke testu nedal omylem vložit token nebo soukromá adresa.
 */
export function parseBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('neplatná URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('URL musí být https (http jen pro localhost)');
  if (url.username || url.password) throw new Error('URL nesmí obsahovat přihlašovací údaje');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('zadej jen origin (např. https://chalupavsetice.cz) bez cesty, query a fragmentu');
  return url;
}

const PERSONAL = /"(firstName|lastName|phone|email|note)"|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export async function runSmoke(baseUrl: URL, env: SmokeEnv, fetchFn: typeof fetch, now: Date = new Date()): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const at = (path: string) => new URL(path, baseUrl).toString();
  const check = async (name: string, fn: () => Promise<Omit<SmokeCheck, 'name'>>) => {
    try {
      checks.push({ name, ...(await fn()) });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : 'chyba' });
    }
  };
  // Žádné Authorization ani cookies; redirect se nesleduje (odhalil by špatnou konfiguraci).
  const request = (path: string, init: RequestInit = {}) => fetchFn(at(path), { redirect: 'manual', ...init });
  const postJson = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const jsonOf = async (response: Response): Promise<{ text: string; body: unknown }> => {
    const text = await response.text();
    try {
      return { text, body: JSON.parse(text) };
    } catch {
      return { text, body: undefined };
    }
  };
  const apiHeaders = (response: Response) =>
    response.headers.get('x-content-type-options') === 'nosniff' && (response.headers.get('content-type') ?? '').startsWith('application/json');

  await check('GET / – web', async () => {
    const response = await request('/');
    await response.body?.cancel();
    const html = (response.headers.get('content-type') ?? '').includes('text/html');
    return { ok: response.status === 200 && html, detail: `HTTP ${response.status}` };
  });

  await check('GET /api/availability – obsazenost bez osobních údajů', async () => {
    const response = await request('/api/availability');
    const { text, body } = await jsonOf(response);
    const status = (body as { status?: unknown } | undefined)?.status;
    if (response.status !== 200 || !apiHeaders(response)) return { ok: false, detail: `HTTP ${response.status}` };
    if (!Array.isArray((body as { busy?: unknown }).busy)) return { ok: false, detail: 'chybí busy[]' };
    if (PERSONAL.test(text)) return { ok: false, detail: 'odpověď obsahuje osobní údaje' };
    if (status === 'ok') return { ok: true, detail: 'status ok' };
    if (status === 'stale' || status === 'partial') return { ok: true, warning: true, detail: `status ${String(status)} – zkontroluj synchronizaci s e-chalupami` };
    return { ok: false, detail: `status ${String(status)}` };
  });

  const arrival = addDays(todayInPrague(now), 60);
  const departure = addDays(arrival, 2);
  await check('POST /api/quote – cenová nabídka', async () => {
    const response = await postJson('/api/quote', { arrivalDate: arrival, departureDate: departure, guests: 2 });
    const { body } = await jsonOf(response);
    const q = body as { nights?: unknown; totalCzk?: unknown; pricingMode?: unknown } | undefined;
    const valid =
      response.status === 200 && apiHeaders(response) && q?.nights === 2 && Number.isInteger(q.totalCzk) && (q.totalCzk as number) > 0 && (q.pricingMode === 'nightly' || q.pricingMode === 'exact-stay');
    const error = (body as { error?: unknown } | undefined)?.error;
    return { ok: valid, detail: valid ? `${arrival} → ${departure}: ${String(q!.totalCzk)} Kč (${String(q!.pricingMode)})` : `HTTP ${response.status}${error ? ` ${String(error)}` : ''}` };
  });

  await check('POST /api/quote – neplatný termín → 422', async () => {
    const response = await postJson('/api/quote', { arrivalDate: departure, departureDate: arrival, guests: 2 });
    const { body } = await jsonOf(response);
    return { ok: response.status === 422 && (body as { error?: unknown })?.error === 'invalid-request', detail: `HTTP ${response.status}` };
  });

  await check('GET /api/quote → 405', async () => {
    const response = await request('/api/quote');
    await response.body?.cancel();
    return { ok: response.status === 405, detail: `HTTP ${response.status}` };
  });

  // Prázdné tělo: zapnutý endpoint ho odmítne validací (422), nebo tokenem (401) – nikdy nevznikne rezervace.
  await check(env === 'production' ? 'POST /api/reservations – v produkci vypnutý (404)' : 'POST /api/reservations – bez údajů odmítnut', async () => {
    const response = await postJson('/api/reservations', {});
    const { body } = await jsonOf(response);
    const error = (body as { error?: unknown } | undefined)?.error;
    if (response.status === 201 || response.status === 200) return { ok: false, detail: `HTTP ${response.status} – endpoint přijal prázdný požadavek!` };
    if (env === 'production') {
      return { ok: response.status === 404 && error === 'not-found', detail: response.status === 404 ? 'vypnutý' : `HTTP ${response.status} – rezervační POST je v produkci zapnutý!` };
    }
    return { ok: [401, 422, 429].includes(response.status), detail: `HTTP ${response.status}${error ? ` ${String(error)}` : ''}` };
  });

  // Frontend nabízí rezervační formulář jen podle tohoto nastavení – v produkci musí být vypnutý.
  await check(env === 'production' ? 'GET /api/booking-config – formulář v produkci vypnutý' : 'GET /api/booking-config – formulář zapnutý s veřejným site key', async () => {
    const response = await request('/api/booking-config');
    const { body } = await jsonOf(response);
    const config = body as { bookingEnabled?: unknown; turnstileSiteKey?: unknown } | undefined;
    if (response.status !== 200 || !apiHeaders(response) || !config) return { ok: false, detail: `HTTP ${response.status}` };
    const keys = Object.keys(config).sort().join(',');
    if (keys !== 'bookingEnabled,turnstileSiteKey') return { ok: false, detail: 'neočekávaná pole v odpovědi' };
    if (env === 'production') {
      const ok = config.bookingEnabled === false && config.turnstileSiteKey === null;
      return { ok, detail: ok ? 'bookingEnabled false' : 'formulář je v produkci zapnutý!' };
    }
    const ok = config.bookingEnabled === true && typeof config.turnstileSiteKey === 'string' && config.turnstileSiteKey !== '';
    return { ok, detail: ok ? 'bookingEnabled true' : 'chybí bookingEnabled nebo TURNSTILE_SITE_KEY' };
  });

  await check('GET /api/reservations.ics bez tokenu → 404', async () => {
    const response = await request('/api/reservations.ics');
    const text = await response.text();
    return { ok: response.status === 404 && !text.includes('BEGIN:VCALENDAR'), detail: `HTTP ${response.status}` };
  });

  await check('GET /api/neexistuje → 404 JSON', async () => {
    const response = await request('/api/neexistuje');
    const { body } = await jsonOf(response);
    return { ok: response.status === 404 && apiHeaders(response) && (body as { error?: unknown })?.error === 'not-found', detail: `HTTP ${response.status}` };
  });

  return checks;
}

export function formatSmoke(checks: readonly SmokeCheck[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => `${c.ok ? (c.warning ? '!' : '✓') : '✗'} ${c.name}${c.detail ? ` – ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push(failed === 0 ? `Smoke test OK (${checks.length} kontrol)` : `Smoke test SELHAL: ${failed} z ${checks.length} kontrol`);
  return { text: lines.join('\n'), ok: failed === 0 };
}
