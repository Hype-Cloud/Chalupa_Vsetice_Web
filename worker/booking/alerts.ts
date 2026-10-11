// Interní e-mailové upozornění správci na kolize rezervací (outbox reservation_conflicts.notified_at).
//
// Pořadí: načíst čekající kolize → odeslat e-mail → teprve po úspěšné odpovědi providera
// označit notified_at. Při chybě zůstane notified_at NULL a další běh to zkusí znovu
// (at-least-once). Duplicity při souběhu nebo opakování omezuje Idempotency-Key odvozený
// z ID kolize. E-mail neobsahuje jméno, kontakty hosta, cizí UID ani adresu exportu.

import { MailError, RESEND_TEST_FROM, sendViaResend } from '../email/resend.ts';
import { markConflictsNotified, pendingConflictNotifications } from './conflicts.ts';

export { MailError, RESEND_ENDPOINT, sendViaResend } from '../email/resend.ts';

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

const DEFAULT_FROM = RESEND_TEST_FROM;
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
