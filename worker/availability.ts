import { addDays, todayInPrague } from '../lib/availability/dates.ts';
import type { AvailabilityResponse, BusyInterval } from '../lib/availability/types.ts';
import { IcalParseError, parseBusyIntervals } from './ical.ts';

/** Data jsou čerstvá 5 minut, pak se export stáhne znovu (při další návštěvě). */
export const FRESH_MS = 5 * 60_000;
/** Při výpadku e-chalup se poslední úspěšná data zobrazují nejdéle 24 hodin (stav `stale`). */
export const STALE_MAX_MS = 24 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 8_000;
/** Po neúspěšném stažení se další pokus provede nejdřív za minutu (ochrana e-chalup při výpadku). */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** Rozsah dat v odpovědi: od včerejška na 400 dní dopředu. */
export const HORIZON_DAYS = 400;

// Některé servery odmítají požadavky bez User-Agent; Worker se identifikuje jako čtečka obsazenosti webu.
const USER_AGENT = 'ChalupaVsetice-Availability/1.0 (+https://chalupavsetice.cz)';

// Klíč cache neobsahuje URL exportu (ta je tajná). Verze se zvyšuje při změně tvaru snapshotu
// (v2: pole events a skipped), aby se po nasazení nepoužily staré snapshoty bez nich.
const CACHE_KEY = 'https://availability.cache.internal/v2/snapshot';

export interface Snapshot {
  busy: BusyInterval[];
  /** ISO 8601 čas úspěšného stažení exportu. */
  updatedAt: string;
  range: { from: string; to: string };
  /** Počet událostí v exportu a počet událostí, které nešlo spolehlivě převést. */
  events: number;
  skipped: number;
}

/** Podmnožina Cache API, kterou služba používá (v testech nahrazená pamětí). */
export interface SnapshotCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface AvailabilityDeps {
  fetch: typeof fetch;
  now: () => Date;
  cache: SnapshotCache | null;
  /** Odložené operace (ctx.waitUntil ve Workeru). */
  defer: (promise: Promise<unknown>) => void;
  log: (message: string) => void;
}

export interface AvailabilityEnv {
  ECHALUPY_ICAL_URL?: string;
}

// Druhá úroveň cache v paměti izolátu (Cache API je per datacentrum a na workers.dev nemusí ukládat).
let memory: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let lastFailureAt = 0;
let lastFailureReason = 'upstream-unknown';

/** Jen pro testy. */
export function resetAvailabilityMemory() {
  memory = null;
  inflight = null;
  lastFailureAt = 0;
  lastFailureReason = 'upstream-unknown';
}

class UpstreamError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

async function readCache(cache: SnapshotCache | null): Promise<Snapshot | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(CACHE_KEY);
    return hit ? ((await hit.json()) as Snapshot) : null;
  } catch {
    return null;
  }
}

async function download(url: string, now: Date, deps: AvailabilityDeps): Promise<Snapshot> {
  const today = todayInPrague(now);
  const range = { from: addDays(today, -1), to: addDays(today, HORIZON_DAYS) };
  let response: Response;
  try {
    // Pouze čtení: GET bez těla a bez přihlašovacích údajů.
    response = await deps.fetch(url, { method: 'GET', headers: { accept: 'text/calendar', 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new UpstreamError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!response.ok) throw new UpstreamError(`http-${response.status}`);
  const text = await response.text();
  try {
    const { busy, events, skipped } = parseBusyIntervals(text, range);
    if (skipped > 0) deps.log(`availability: ${skipped} of ${events} events could not be parsed reliably`);
    return { busy, updatedAt: now.toISOString(), range, events, skipped };
  } catch (error) {
    throw new UpstreamError(error instanceof IcalParseError ? 'invalid-ical' : 'parse');
  }
}

function respond(requested: AvailabilityResponse['status'], snapshot: Snapshot | null, now: Date, failureReason?: string): AvailabilityResponse {
  const today = todayInPrague(now);
  // Export s nepřevedenými událostmi se nesmí tvářit jako kompletní obsazenost – ani když se
  // jako záloha (stale) vrací starší neúplný snapshot. Příznak incomplete proto nese každá odpověď.
  const incomplete = !!snapshot && (snapshot.skipped ?? 0) > 0;
  const status = requested === 'ok' && incomplete ? 'partial' : requested;
  const reason = failureReason ?? (incomplete ? 'skipped-events' : undefined);
  return {
    status,
    incomplete,
    ...(reason ? { reason } : {}),
    busy: snapshot ? snapshot.busy.filter((i) => i.end > addDays(today, -1)) : [],
    updatedAt: snapshot?.updatedAt ?? null,
    checkedAt: now.toISOString(),
    range: snapshot?.range ?? { from: today, to: today },
    ...(snapshot ? { source: { events: snapshot.events ?? 0, skipped: snapshot.skipped ?? 0 } } : {}),
  };
}

export async function getAvailability(env: AvailabilityEnv, deps: AvailabilityDeps): Promise<AvailabilityResponse> {
  const now = deps.now();
  const url = env.ECHALUPY_ICAL_URL?.trim();
  if (!url) {
    deps.log('availability: ECHALUPY_ICAL_URL is not configured');
    return respond('unavailable', null, now, 'not-configured');
  }

  const cached = memory ?? (await readCache(deps.cache));
  const age = (snapshot: Snapshot) => now.getTime() - Date.parse(snapshot.updatedAt);
  if (cached && age(cached) < FRESH_MS) {
    memory = cached;
    return respond('ok', cached, now);
  }

  const fallback = () => (cached && age(cached) < STALE_MAX_MS ? respond('stale', cached, now, lastFailureReason) : respond('unavailable', null, now, lastFailureReason));
  if (now.getTime() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return fallback();

  try {
    // Souběžné požadavky sdílí jedno stažení exportu.
    inflight ??= download(url, now, deps).finally(() => {
      inflight = null;
    });
    const fresh = await inflight;
    memory = fresh;
    lastFailureAt = 0;
    if (deps.cache) {
      const body = new Response(JSON.stringify(fresh), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${STALE_MAX_MS / 1000}` } });
      deps.defer(deps.cache.put(CACHE_KEY, body).catch(() => undefined));
    }
    return respond('ok', fresh, now);
  } catch (error) {
    // Do logu jde jen druh chyby, nikdy URL exportu.
    const kind = error instanceof UpstreamError ? error.kind : 'unknown';
    deps.log(`availability: upstream failed (${kind})`);
    lastFailureAt = now.getTime();
    lastFailureReason = `upstream-${kind}`;
    return fallback();
  }
}
