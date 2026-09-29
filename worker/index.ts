// Cloudflare Worker: obsluhuje pouze /api/* (assets.run_worker_first ve wrangler.jsonc).
// Všechny ostatní požadavky obsluhují statické assety z dist/client bez spuštění Workeru.
import { getAvailability, type AvailabilityEnv } from './availability.ts';

interface Env extends AvailabilityEnv {
  ASSETS: Fetcher;
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function json(body: unknown, init: ResponseInit & { cacheControl: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': init.cacheControl, ...SECURITY_HEADERS, ...init.headers },
  });
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
  });
  // Krátká cache v prohlížeči; neúplná data se necachují.
  return json(data, { cacheControl: data.status === 'ok' ? 'public, max-age=60' : 'no-store' });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/availability') return handleAvailability(request, env, ctx);
    if (pathname.startsWith('/api/')) return json({ error: 'not-found' }, { status: 404, cacheControl: 'no-store' });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
