// Interní e-mailové upozornění správci na kolize rezervací (outbox reservation_conflicts.notified_at).
//
// Pořadí: načíst čekající kolize → odeslat e-mail → teprve po úspěšné odpovědi providera
// označit notified_at. Při chybě zůstane notified_at NULL a další běh to zkusí znovu
// (at-least-once). Duplicity při souběhu nebo opakování omezuje Idempotency-Key odvozený
// z ID kolize. E-mail neobsahuje jméno, kontakty hosta, cizí UID ani adresu exportu.

import { markConflictsNotified, pendingConflictNotifications } from './conflicts.ts';

export interface AlertEnv {
  BOOKING_ENV?: string;
  /** Secret: API klíč Resend. */
  RESEND_API_KEY?: string;
  /** Secret: adresa správce, kam chodí upozornění (osobní údaj – mimo veřejný repozitář). */
  CONFLICT_ALERT_EMAIL?: string;
  /** Odesílatel; bez nastavení testovací odesílatel Resend (doručí jen na e-mail účtu Resend). */
  CONFLICT_ALERT_FROM?: string;
}

export interface AlertDeps {
  fetch: typeof fetch;
  log: (message: string) => void;
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Chalupa Všetice <onboarding@resend.dev>';
const SEND_TIMEOUT_MS = 10_000;
/** Pojistka proti zahlcení schránky při hromadné chybě; zbytek počká na další běh. */
export const MAX_ALERTS_PER_RUN = 20;

export interface ConflictAlert {
  id: number;
  reservationCode: string;
  start: string;
  end: string;
  detectedAt: string;
}

const czDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}. ${m}. ${y}`;
};

const nightsBetween = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);

const pragueTime = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

/** Text upozornění – jen provozní údaje, žádné osobní údaje hosta. */
export function buildConflictAlert(alert: ConflictAlert, test: boolean): { subject: string; text: string } {
  const prefix = test ? '[TEST] ' : '';
  const nights = nightsBetween(alert.start, alert.end);
  return {
    subject: `${prefix}POZOR: kolize rezervace ${alert.reservationCode}`,
    text: [
      'V externím kalendáři se objevil termín překrývající rezervaci z webu.',
      'Zkontrolujte e-chalupy / Booking / Airbnb.',
      '',
      `Rezervace z webu: ${alert.reservationCode}`,
      `Kolidující termín: ${czDate(alert.start)} – ${czDate(alert.end)} (${nights} ${nights === 1 ? 'noc' : nights < 5 ? 'noci' : 'nocí'})`,
      `Zjištěno: ${pragueTime(alert.detectedAt)}`,
      '',
      'Nic se automaticky neruší. Kolizi je potřeba vyřešit ručně.',
    ].join('\n'),
  };
}

export class MailError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

/** Jeden e-mail přes Resend HTTP API. @throws MailError (bez obsahu odpovědi) */
export async function sendViaResend(
  apiKey: string,
  message: { from: string; to: string; subject: string; text: string; idempotencyKey: string },
  fetchFn: typeof fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': message.idempotencyKey },
      body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MailError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new MailError(`http-${response.status}`);
}

/**
 * Odešle upozornění na trvající kolize s notified_at IS NULL a po úspěchu je označí.
 * Selhání jednoho e-mailu neblokuje ostatní; neodeslané zůstanou čekající.
 */
export async function processPendingAlerts(db: D1Database, env: AlertEnv, deps: AlertDeps, now: Date): Promise<{ sent: number; failed: number }> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.CONFLICT_ALERT_EMAIL?.trim();
  const pending = (await pendingConflictNotifications(db)).slice(0, MAX_ALERTS_PER_RUN);
  if (pending.length === 0) return { sent: 0, failed: 0 };
  if (!apiKey || !to) {
    deps.log(`conflicts-mail: not configured (${pending.length} pending)`);
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const alert of pending) {
    const { subject, text } = buildConflictAlert(alert, env.BOOKING_ENV !== 'production');
    try {
      await sendViaResend(apiKey, { from: env.CONFLICT_ALERT_FROM?.trim() || DEFAULT_FROM, to, subject, text, idempotencyKey: `conflict-alert-${env.BOOKING_ENV}-${alert.id}` }, deps.fetch);
    } catch (error) {
      failed++;
      deps.log(`conflicts-mail: send failed (${error instanceof MailError ? error.kind : 'unknown'})`);
      continue;
    }
    // Až po úspěšném odeslání. Selže-li zápis, další běh e-mail zopakuje (Idempotency-Key duplicitu potlačí).
    await markConflictsNotified(db, [alert.id], now);
    sent++;
  }
  if (sent > 0) deps.log(`conflicts-mail: ${sent} sent`);
  return { sent, failed };
}
