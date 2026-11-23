// Upozornění správci při problému se zálohou (Resend) – společné pro všechny spouštěče.
//
// Jen prostředí, databáze, backend, druh chyby, čas, poslední úspěšná záloha a doporučená akce.
// Nikdy token, podepsaná URL, obsah SQL, osobní údaje ani klíče. Úspěšné zálohy e-mail neposílají.
// Chybějící konfigurace vrací `skipped`; o závažnosti rozhoduje volající (v produkci chyba běhu).

import { MailError, RESEND_TEST_FROM, sendViaResend } from '../../worker/email/resend.ts';

export interface AlertSecrets {
  RESEND_API_KEY?: string;
  CONFLICT_ALERT_EMAIL?: string;
  CONFLICT_ALERT_FROM?: string;
}

export interface AlertStatus {
  /** Poslední úspěšná denní záloha (identifikátor a čas), nebo null. */
  latest: { key: string; uploaded: string } | null;
  dailyCount: number;
  monthlyCount: number;
  totalBytes: number;
}

export interface BackupAlert {
  kind: string;
  /** Datum snapshotu, ke kterému se upozornění vztahuje. */
  date: string;
  status: AlertStatus | null;
  /** Klíč idempotence (výchozí datum) – nejvýš jedno upozornění daného druhu za den. */
  idempotencyKey?: string;
}

export const alertsConfigured = (secrets: AlertSecrets) => !!secrets.RESEND_API_KEY?.trim() && !!secrets.CONFLICT_ALERT_EMAIL?.trim();

const KIND_TEXT: Record<string, string> = {
  'backup-stale': 'Poslední úspěšná denní záloha D1 je starší než 48 hodin (nebo žádná neexistuje).',
  'storage-near-limit': 'Objem záloh v R2 překročil 7 GB (bezplatná kvóta R2 Standard je 10 GB-month).',
  'alert-test': 'Testovací upozornění zálohování – doručení upozornění funguje. Nic dalšího není potřeba.',
  'monitor-failed': 'Kontrola stáří záloh se nepodařila – stav záloh není ověřený.',
  'retention-failed': 'Záloha je uložená, ale retence starých snapshotů se nepodařila – nic dalšího se nesmazalo.',
};

const ACTION: Record<string, string> = {
  'backup-failed': 'Zkontrolovat poslední běh zálohy (GitHub Actions / Cloudflare Workflows) a jeho log; starší zálohy jsou zachované.',
  'backup-stale': 'Zkontrolovat, zda zálohovací workflow běží (zakázaný rozvrh, chybějící secrets, výpadek) a spustit zálohu ručně.',
  'storage-near-limit': 'Zkontrolovat objem bucketu a retenci; případně snížit BACKUP_KEEP_DAILY / BACKUP_KEEP_MONTHLY.',
  'monitor-failed': 'Zkontrolovat token a konfiguraci kontroly; ověřit stav záloh ručně (backup:list).',
  'retention-failed': 'Zkontrolovat oprávnění tokenu a výpis snapshotů (backup:list); retence se zopakuje při dalším běhu.',
  'alert-test': 'Žádná.',
};

/** Text upozornění – bez dat z databáze. */
export function buildBackupAlert(alert: BackupAlert & { env: string; database: string; backend: string; at: Date }): { subject: string; text: string } {
  const prefix = alert.env === 'production' ? '' : '[TEST] ';
  const [base, detail] = alert.kind.split(':');
  const time = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', dateStyle: 'short', timeStyle: 'medium' }).format(alert.at);
  const description =
    base === 'backup-failed'
      ? `Automatická záloha D1 se nepodařila (${detail ?? 'unknown'}). Starší zálohy zůstávají beze změny.${detail === 'storage-limit' ? ' Objem úložiště je u stropu – nová záloha se nezapsala.' : ''}`
      : base === 'monitor-failed' || base === 'retention-failed'
        ? `${KIND_TEXT[base]} (${detail ?? 'unknown'})`
        : (KIND_TEXT[base] ?? base);
  const status = alert.status;
  return {
    subject: `${prefix}${base === 'alert-test' ? 'Test' : 'POZOR'}: záloha D1 ${alert.database} – ${base}`,
    text: [
      description,
      '',
      `Databáze: ${alert.database}`,
      `Prostředí: ${alert.env}`,
      `Úložiště: ${alert.backend}`,
      `Datum zálohy: ${alert.date}`,
      ...(status
        ? [
            `Poslední denní záloha: ${status.latest ? `${status.latest.key} (${status.latest.uploaded})` : 'žádná'}`,
            `Snapshoty: ${status.dailyCount} denních, ${status.monthlyCount} měsíčních`,
            `Objem záloh: ${(status.totalBytes / 1024 ** 2).toFixed(1)} MB`,
          ]
        : []),
      `Čas: ${time} (${alert.at.toISOString()})`,
      `Doporučená akce: ${ACTION[base] ?? ACTION['backup-failed']}`,
      '',
      'Postup: README, sekce „Automatické zálohy D1“.',
    ].join('\n'),
  };
}

/**
 * E-mail správci. Bez konfigurace `skipped`. Selhání odeslání vyhodí MailError, aby se krok
 * zopakoval (o výsledku běhu rozhoduje volající – záloha se kvůli upozornění nikdy neruší).
 */
export async function sendBackupAlert(
  secrets: AlertSecrets,
  context: { env: string; database: string; backend: string },
  deps: { fetch: typeof fetch; log: (message: string) => void; now: () => Date },
  alert: BackupAlert,
): Promise<'sent' | 'skipped'> {
  const apiKey = secrets.RESEND_API_KEY?.trim();
  const to = secrets.CONFLICT_ALERT_EMAIL?.trim();
  if (!apiKey || !to) {
    deps.log('d1-backup: alert skipped (not configured)');
    return 'skipped';
  }
  const { subject, text } = buildBackupAlert({ ...alert, ...context, at: deps.now() });
  const key = `d1-backup-${context.env}-${alert.kind}-${alert.idempotencyKey ?? alert.date}`.replace(/[^A-Za-z0-9_-]/g, '-');
  try {
    await sendViaResend(apiKey, { from: secrets.CONFLICT_ALERT_FROM?.trim() || RESEND_TEST_FROM, to, subject, text, idempotencyKey: key }, deps.fetch);
  } catch (error) {
    deps.log(`d1-backup: alert failed (${error instanceof MailError ? error.kind : 'unknown'})`);
    throw error;
  }
  deps.log(`d1-backup: alert sent (${alert.kind})`);
  return 'sent';
}
