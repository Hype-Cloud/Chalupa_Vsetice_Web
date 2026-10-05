// Ověření Cloudflare Turnstile tokenu na serveru (Siteverify API).
//
// - Ověřuje se vždy, i v Preview a lokálně – tam s testovacím secret klíčem Cloudflare
//   (1x0000000000000000000000000000000AA přijme testovací token XXXX.DUMMY.TOKEN.XXXX).
//   Kód nemá žádný „bypass“ přepínač.
// - V produkci se testovací secret klíč odmítne (endpoint se tváří jako nenakonfigurovaný).
// - Chyba Siteverify (síť, timeout, neplatná odpověď) = odmítnutí (fail-closed).
// - Token ani odpověď Siteverify se nelogují; ven jdou jen kódy chyb Turnstile.

import { sha256 } from '../secrets.ts';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;
/** Maximální délka tokenu podle dokumentace Turnstile. */
export const MAX_TOKEN_LENGTH = 2048;

/** Testovací secret klíče Cloudflare (vždy projde / vždy selže / „už použito“). */
export const isTestTurnstileSecret = (secret: string) => /^[123]x0+AA$/.test(secret);

export type TurnstileResult = { ok: true } | { ok: false; reason: 'invalid'; codes: string[] } | { ok: false; reason: 'unavailable'; detail: string };

/** UUID odvozené z klíče – stejný klíč = stejný idempotency_key pro Siteverify (bezpečný retry). */
async function uuidFrom(value: string): Promise<string> {
  const hex = Array.from(await sha256(value), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  options: { remoteIp: string | null; idempotencyKey: string | null },
  fetchFn: typeof fetch,
): Promise<TurnstileResult> {
  const body: Record<string, string> = { secret, response: token };
  if (options.remoteIp) body.remoteip = options.remoteIp;
  // Opakovaný požadavek se stejným Idempotency-Key smí stejný (jednorázový) token ověřit znovu.
  if (options.idempotencyKey) body.idempotency_key = await uuidFrom(`turnstile:${options.idempotencyKey}`);
  let response: Response;
  try {
    response = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: 'unavailable', detail: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (!response.ok) return { ok: false, reason: 'unavailable', detail: `http-${response.status}` };
  let result: { success?: unknown; 'error-codes'?: unknown };
  try {
    result = await response.json();
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'invalid-response' };
  }
  if (result.success === true) return { ok: true };
  const codes = Array.isArray(result['error-codes']) ? result['error-codes'].filter((c): c is string => typeof c === 'string' && /^[a-z-]{1,40}$/.test(c)) : [];
  // Chyba na straně Cloudflare nebo chybný secret se nesmí tvářit jako neplatný token hosta.
  if (codes.includes('internal-error')) return { ok: false, reason: 'unavailable', detail: 'internal-error' };
  if (codes.includes('missing-input-secret') || codes.includes('invalid-input-secret')) return { ok: false, reason: 'unavailable', detail: 'invalid-secret' };
  return { ok: false, reason: 'invalid', codes };
}
