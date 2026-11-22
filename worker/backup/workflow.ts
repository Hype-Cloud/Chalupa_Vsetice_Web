// Průběh Workflow zálohy nad injektovanými závislostmi (testovatelné mimo runtime Workflows).
//
// - Rozvrh `BACKUP_CRON` (02:15 UTC): záloha. `MONITOR_CRON` (14:45 UTC): jen kontrola stáří
//   poslední denní zálohy (> 48 h) a objemu (> 7 GB). Ručně: payload { mode: backup | monitor |
//   alert-test } (alert-test jen ověří doručení upozornění, na D1 ani R2 nesahá).
// - Kroky jsou idempotentní: existující denní snapshot = export se přeskočí; pending/ je vázaný na
//   instanci; snapshot se zapisuje podmíněně (If-None-Match: *), takže ho nepřepíše ani souběžná
//   instance.
// - Před exportem: úklid pending/ starších než 24 h a kontrola kapacity bucketu (tvrdý strop
//   STORAGE_HARD_LIMIT_BYTES) – nad stropem se nic nezapisuje.
// - Upozornění: v produkci jsou povinná. Chybějící RESEND_API_KEY / CONFLICT_ALERT_EMAIL nebo
//   neúspěšné doručení ukončí instanci chybou (`alerts-not-configured`, `alert-delivery-failed`),
//   ale až po uložení zálohy – vytvořená záloha se kvůli upozornění nikdy neruší ani nemaže.
// - Výsledky kroků obsahují jen metadata (klíč, velikost, MD5, bookmark) – nikdy podepsanou
//   URL ani obsah zálohy (stav Workflow je vidět v dashboardu).

import { sendViaResend, MailError, RESEND_TEST_FROM } from '../email/resend.ts';
import {
  backupStatus,
  BackupError,
  cleanPending,
  copySnapshot,
  dailyKey,
  exportToPending,
  MAX_EXPORT_BYTES,
  monthlyKey,
  pendingKey,
  pruneDaily,
  pruneMonthly,
  STORAGE_HARD_LIMIT_BYTES,
  utcDate,
  type BackupDeps,
  type BackupStatus,
  type ExportConfig,
} from './backup.ts';

export const BACKUP_CRON = '15 2 * * *';
export const MONITOR_CRON = '45 14 * * *';

export interface BackupEnv {
  BACKUPS: R2Bucket;
  /** production | preview – očekávané meta.environment v exportu. */
  BACKUP_ENV?: string;
  DATABASE_NAME?: string;
  DATABASE_ID?: string;
  /** Secret: ID účtu Cloudflare (mimo veřejný repozitář). */
  D1_EXPORT_ACCOUNT_ID?: string;
  /** Secret: API token s oprávněním exportu D1 (D1 Edit). */
  D1_EXPORT_API_TOKEN?: string;
  /** Secrets pro upozornění (v produkci povinné). */
  RESEND_API_KEY?: string;
  CONFLICT_ALERT_EMAIL?: string;
  CONFLICT_ALERT_FROM?: string;
}

export type BackupMode = 'backup' | 'monitor' | 'alert-test';

export interface BackupParams {
  mode?: BackupMode;
}

/** Událost Workflow; `schedule` doplňuje runtime u instancí z `schedules`. */
export interface BackupEvent {
  payload?: Readonly<BackupParams>;
  timestamp: Date;
  instanceId: string;
  schedule?: { cron: string; scheduledTime: number | string | Date };
}

type StepConfig = { retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string | number };
/** Podmnožina WorkflowStep, kterou Workflow používá. */
export interface BackupStep {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
}

const EXPORT_STEP: StepConfig = { retries: { limit: 3, delay: '10 minutes', backoff: 'exponential' }, timeout: '15 minutes' };
const STORAGE_STEP: StepConfig = { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' };
const ALERT_STEP: StepConfig = { retries: { limit: 3, delay: '2 minutes', backoff: 'exponential' }, timeout: '2 minutes' };

type StatusSummary = Pick<BackupStatus, 'stale' | 'nearLimit' | 'totalBytes' | 'dailyCount' | 'monthlyCount' | 'latest'>;

export interface BackupResult {
  mode: BackupMode;
  date: string;
  daily?: 'stored' | 'exists';
  monthly?: 'stored' | 'exists' | 'kept';
  bytes?: number;
  pruned?: number;
  status: StatusSummary | null;
  alerts: string[];
}

export function exportConfig(env: BackupEnv): ExportConfig {
  return {
    accountId: env.D1_EXPORT_ACCOUNT_ID?.trim() ?? '',
    databaseId: env.DATABASE_ID?.trim() ?? '',
    databaseName: env.DATABASE_NAME?.trim() ?? '',
    environment: env.BACKUP_ENV?.trim() ?? '',
    apiToken: env.D1_EXPORT_API_TOKEN?.trim() ?? '',
  };
}

export function runMode(event: BackupEvent): BackupMode {
  if (event.schedule) return event.schedule.cron === MONITOR_CRON ? 'monitor' : 'backup';
  const mode = event.payload?.mode;
  return mode === 'monitor' || mode === 'alert-test' ? mode : 'backup';
}

/** Datum snapshotu: plánovaný čas spuštění (UTC), u ručního běhu čas události. */
export const runDate = (event: BackupEvent) => utcDate(event.schedule ? new Date(event.schedule.scheduledTime) : event.timestamp);

/** Upozornění jsou nakonfigurovaná (oba secrets). */
export const alertsConfigured = (env: BackupEnv) => !!env.RESEND_API_KEY?.trim() && !!env.CONFLICT_ALERT_EMAIL?.trim();
/** V produkci jsou upozornění povinná. */
export const alertsRequired = (env: BackupEnv) => env.BACKUP_ENV?.trim() === 'production';

/** Problém s kapacitou bucketu před novým exportem (null = lze zapisovat). */
export function capacityProblem(totalBytes: number): string | null {
  // Nový export: pending/ + denní kopie (+ měsíční) – rezerva tří maximálních exportů.
  return totalBytes + 3 * MAX_EXPORT_BYTES > STORAGE_HARD_LIMIT_BYTES ? 'storage-limit' : null;
}

export async function runBackupWorkflow(event: BackupEvent, step: BackupStep, env: BackupEnv, deps: BackupDeps): Promise<BackupResult> {
  const mode = runMode(event);
  const date = runDate(event);
  const config = exportConfig(env);
  const alerts: string[] = [];
  const undelivered: string[] = [];
  const alert = async (kind: string, status?: BackupStatus | null) => {
    alerts.push(kind);
    try {
      const state = await step.do(`upozornění ${kind}`, ALERT_STEP, async () =>
        sendBackupAlert(env, deps, { kind, date, status: status ?? null, idempotencyKey: mode === 'alert-test' ? event.instanceId : date }),
      );
      // `skipped` (bez konfigurace) je problém jen tam, kde jsou upozornění povinná (produkce).
      if (state !== 'sent' && alertsRequired(env)) undelivered.push(kind);
    } catch {
      // Výpadek Resend nesmí zrušit zálohu – instance jen na konci skončí chybou.
      undelivered.push(kind);
    }
  };
  /** Na konci běhu: v produkci je nedoručené / nenakonfigurované upozornění chyba instance. */
  const finish = (result: BackupResult): BackupResult => {
    if (alertsRequired(env) && !alertsConfigured(env)) {
      deps.log('d1-backup: alerts not configured (RESEND_API_KEY, CONFLICT_ALERT_EMAIL) – produkce bez upozornění');
      throw new BackupError('alerts-not-configured');
    }
    if (undelivered.length > 0) throw new BackupError('alert-delivery-failed');
    return result;
  };

  if (mode === 'alert-test') {
    if (!alertsConfigured(env)) throw new BackupError('alerts-not-configured');
    await alert('alert-test');
    if (undelivered.length > 0) throw new BackupError('alert-delivery-failed');
    return { mode, date, status: null, alerts };
  }

  if (mode === 'monitor') {
    const status = await step.do('kontrola záloh', STORAGE_STEP, async () => {
      await cleanPending(deps.bucket, deps.now());
      return backupStatus(deps.bucket, deps.now());
    });
    if (status.stale) await alert('backup-stale', status);
    if (status.nearLimit) await alert('storage-near-limit', status);
    return finish({ mode, date, status: pick(status), alerts });
  }

  const daily = dailyKey(date);
  const pending = pendingKey(event.instanceId);
  let result: Omit<BackupResult, 'status' | 'alerts'>;
  try {
    // Příprava: úklid pozůstatků neúspěšných běhů, stav dnešní zálohy a kapacita bucketu.
    const prepared = await step.do('příprava', STORAGE_STEP, async () => {
      await cleanPending(deps.bucket, deps.now());
      const object = await deps.bucket.head(daily);
      const status = await backupStatus(deps.bucket, deps.now());
      return { existing: object?.checksums.md5 ? { bytes: object.size, md5: hexOf(object.checksums.md5) } : null, totalBytes: status.totalBytes };
    });
    let snapshot = prepared.existing;
    let dailyState: 'stored' | 'exists' = 'exists';
    if (!snapshot) {
      const limit = capacityProblem(prepared.totalBytes);
      if (limit) throw new BackupError(limit);
      const exported = await step.do('export D1 do pending', EXPORT_STEP, () => exportToPending(config, deps, pending));
      const metadata = { database: config.databaseName, environment: config.environment, bookmark: exported.bookmark, createdAt: deps.now().toISOString(), migrations: exported.migrations };
      dailyState = await step.do('uložení denní zálohy', STORAGE_STEP, async () => {
        const state = await copySnapshot(deps.bucket, exported.key, daily, exported, metadata, 'verify');
        await deps.bucket.delete(exported.key);
        return state === 'stored' ? 'stored' : 'exists';
      });
      snapshot = { bytes: exported.bytes, md5: exported.md5 };
    }
    const target = snapshot;
    // Měsíční snapshot = první úspěšná záloha měsíce; existující (z dřívějšího dne) zůstává.
    const monthly = await step.do('měsíční záloha', STORAGE_STEP, async () => {
      const source = await deps.bucket.head(daily);
      const custom = source?.customMetadata ?? {};
      return copySnapshot(
        deps.bucket,
        daily,
        monthlyKey(date),
        target,
        {
          database: custom.database ?? config.databaseName,
          environment: custom.environment ?? config.environment,
          bookmark: custom.bookmark ?? '',
          createdAt: custom.createdAt ?? deps.now().toISOString(),
          migrations: Number(custom.migrations ?? 0),
        },
        'keep',
      );
    });
    // Retence až po úspěšném uložení – neúspěšný běh nic nemaže.
    const pruned = await step.do('retence', STORAGE_STEP, async () => {
      const removed = [...(await pruneDaily(deps.bucket)), ...(await pruneMonthly(deps.bucket))];
      return removed.length;
    });
    result = { mode, date, daily: dailyState, monthly, bytes: target.bytes, pruned };
  } catch (error) {
    const kind = error instanceof BackupError ? error.kind : 'unknown';
    deps.log(`d1-backup: backup failed (${kind})`);
    await alert(`backup-failed:${kind}`);
    if (alertsRequired(env) && !alertsConfigured(env)) deps.log('d1-backup: alerts not configured (RESEND_API_KEY, CONFLICT_ALERT_EMAIL) – produkce bez upozornění');
    throw error;
  }

  // Kontrola objemu po úspěšné záloze; její selhání zálohu nezneplatní (hlídá ji i běh 14:45).
  let status: BackupStatus | null = null;
  try {
    status = await step.do('kontrola objemu', STORAGE_STEP, () => backupStatus(deps.bucket, deps.now()));
  } catch (error) {
    deps.log(`d1-backup: status check failed (${error instanceof BackupError ? error.kind : 'unknown'})`);
  }
  if (status?.nearLimit) await alert('storage-near-limit', status);
  deps.log(`d1-backup: ok (${result.daily}, ${result.bytes} B${status ? `, ${status.dailyCount} denních, ${status.monthlyCount} měsíčních` : ''})`);
  return finish({ ...result, status: status ? pick(status) : null, alerts });
}

const pick = (s: BackupStatus): StatusSummary => ({ stale: s.stale, nearLimit: s.nearLimit, totalBytes: s.totalBytes, dailyCount: s.dailyCount, monthlyCount: s.monthlyCount, latest: s.latest });
const hexOf = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

// --- Upozornění správci ------------------------------------------------------------------------

const KIND_TEXT: Record<string, string> = {
  'backup-stale': 'Poslední úspěšná denní záloha D1 je starší než 48 hodin (nebo žádná neexistuje).',
  'storage-near-limit': 'Objem záloh v R2 překročil 7 GB (bezplatná kvóta R2 Standard je 10 GB-month).',
  'alert-test': 'Testovací upozornění zálohovacího Workeru – doručení upozornění funguje. Nic dalšího není potřeba.',
};

/** Text upozornění – jen prostředí, druh chyby, čas a stav záloh; žádná data z databáze. */
export function buildBackupAlert(alert: { kind: string; env: string; database: string; date: string; status: BackupStatus | null; at: Date }): { subject: string; text: string } {
  const prefix = alert.env === 'production' ? '' : '[TEST] ';
  const [base, detail] = alert.kind.split(':');
  const time = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', dateStyle: 'short', timeStyle: 'medium' }).format(alert.at);
  const description =
    base === 'backup-failed'
      ? `Automatická záloha D1 se nepodařila (${detail ?? 'unknown'}). Starší zálohy zůstávají beze změny.${detail === 'storage-limit' ? ' Objem bucketu je u stropu – nová záloha se nezapsala.' : ''}`
      : (KIND_TEXT[base] ?? base);
  const status = alert.status;
  return {
    subject: `${prefix}${base === 'alert-test' ? 'Test' : 'POZOR'}: záloha D1 ${alert.database} – ${base}`,
    text: [
      description,
      '',
      `Databáze: ${alert.database}`,
      `Prostředí: ${alert.env}`,
      `Datum zálohy: ${alert.date}`,
      ...(status
        ? [
            `Poslední denní záloha: ${status.latest ? `${status.latest.key} (${status.latest.uploaded})` : 'žádná'}`,
            `Snapshoty: ${status.dailyCount} denních, ${status.monthlyCount} měsíčních`,
            `Objem záloh: ${(status.totalBytes / 1024 ** 2).toFixed(1)} MB`,
          ]
        : []),
      `Čas: ${time} (${alert.at.toISOString()})`,
      '',
      'Postup: README, sekce „Automatické zálohy D1“.',
    ].join('\n'),
  };
}

/**
 * E-mail správci. Bez konfigurace `skipped` (o závažnosti rozhoduje volající – v produkci chyba
 * instance). Selhání odeslání vyhodí MailError, aby se krok Workflow zopakoval.
 */
export async function sendBackupAlert(
  env: BackupEnv,
  deps: Pick<BackupDeps, 'fetch' | 'log' | 'now'>,
  alert: { kind: string; date: string; status: BackupStatus | null; idempotencyKey?: string },
): Promise<'sent' | 'skipped'> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.CONFLICT_ALERT_EMAIL?.trim();
  if (!apiKey || !to) {
    deps.log('d1-backup: alert skipped (not configured)');
    return 'skipped';
  }
  const environment = env.BACKUP_ENV?.trim() || 'unknown';
  const { subject, text } = buildBackupAlert({ ...alert, env: environment, database: env.DATABASE_NAME?.trim() || 'D1', at: deps.now() });
  const key = `d1-backup-${environment}-${alert.kind}-${alert.idempotencyKey ?? alert.date}`.replace(/[^A-Za-z0-9_-]/g, '-');
  try {
    await sendViaResend(apiKey, { from: env.CONFLICT_ALERT_FROM?.trim() || RESEND_TEST_FROM, to, subject, text, idempotencyKey: key }, deps.fetch);
  } catch (error) {
    deps.log(`d1-backup: alert failed (${error instanceof MailError ? error.kind : 'unknown'})`);
    throw error;
  }
  deps.log(`d1-backup: alert sent (${alert.kind})`);
  return 'sent';
}
