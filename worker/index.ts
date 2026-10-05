// Cloudflare Worker: obsluhuje pouze /api/* (assets.run_worker_first ve wrangler.jsonc).
// Všechny ostatní požadavky obsluhují statické assety z dist/client bez spuštění Workeru.
import { getAvailability } from './availability.ts';
import { runConflictReconciliation } from './booking/conflicts.ts';
import { listReservedNights } from './booking/db.ts';
import { handleIcalExport, type ExportEnv } from './booking/export.ts';
import { handleCreateReservation, type BookingEnv } from './booking/handler.ts';
import { json } from './http.ts';

interface Env extends BookingEnv, ExportEnv {
  ASSETS: Fetcher;
}

async function handleAvailability(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method-not-allowed' }, { status: 405, cacheControl: 'no-store', headers: { allow: 'GET, HEAD' } });
  }
  const data = await getAvailability(env, {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    // Typy DOM v tsconfig neznají caches.default z Workers runtime.
    cache: typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null,
    defer: (promise) => ctx.waitUntil(promise),
    log: (message) => console.warn(message),
    // Vlastní rezervace z D1 (pokud je databáze připojená) se přidají k obsazenosti z e-chalup.
    reservedNights: env.DB ? (range) => listReservedNights(env.DB!, range) : undefined,
    // Detekce kolizí vlastních rezervací s cizími událostmi exportu (odloženě, viz conflicts.ts).
    onFreshSnapshot: env.DB ? (snapshot, now) => runConflictReconciliation(env, snapshot, now, (message) => console.warn(message)) : undefined,
  });
  // Krátká cache v prohlížeči; neúplná data se necachují.
  return json(data, { cacheControl: data.status === 'ok' ? 'public, max-age=60' : 'no-store' });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/availability') return handleAvailability(request, env, ctx);
    if (pathname === '/api/reservations') {
      return handleCreateReservation(request, env, {
        fetch: (input, init) => fetch(input, init),
        now: () => new Date(),
        randomUUID: () => crypto.randomUUID(),
        log: (message) => console.warn(message),
      });
    }
    if (pathname === '/api/reservations.ics') return handleIcalExport(request, env, { log: (message) => console.warn(message) });
    if (pathname.startsWith('/api/')) return json({ error: 'not-found' }, { status: 404, cacheControl: 'no-store' });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
