const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

export function json(body: unknown, init: ResponseInit & { cacheControl: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': init.cacheControl, ...SECURITY_HEADERS, ...init.headers },
  });
}
