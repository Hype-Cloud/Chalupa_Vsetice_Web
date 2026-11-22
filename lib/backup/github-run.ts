// Běh zálohy do GitHub Releases a kontrola stáří – spouští GitHub Actions (scripts/backup.ts
// run), ruční CLI a nezávislý monitor (worker/backup-monitor).
//
// Záloha: export D1 → validace SQL → SHA-256 → gzip (ověřený) → age → manifest → draft →
// upload → ověření staženého obsahu → publikace → měsíční snapshot (stejný soubor) → retence.
// Neúspěšný běh nic nemaže; retence běží jen po úspěšném uložení denního snapshotu.
// Upozornění jen při problému; v produkci jsou povinná (bez konfigurace běh skončí chybou,
// ale až po uložení zálohy).

import { alertsConfigured, sendBackupAlert, type AlertSecrets, type AlertStatus } from './alerts.ts';
import { parseBackupConfig, type BackupConfig } from './config.ts';
import { BackupError, errorKind, exportVerified, STALE_AFTER_MS, utcDate } from './core.ts';
import { applyRetention, downloadSnapshot, GithubClient, githubStatus, identifySnapshot, publishSnapshot, releaseTag, type GithubDeps, type GithubStatus, type PublishState } from './github.ts';
import { sealSnapshot } from './seal.ts';
import { buildManifest, manifestFor, monthOf, snapshotBaseName, type SnapshotRef } from './snapshot.ts';

export type GithubEnv = Readonly<Record<string, string | undefined>> & AlertSecrets;

export interface GithubRunResult {
  mode: 'backup' | 'monitor' | 'alert-test';
  date: string;
  daily?: 'stored' | 'exists';
  monthly?: PublishState;
  bytes?: number;
  pruned?: number;
  status: GithubStatus | null;
  alerts: string[];
}

const token = (env: GithubEnv) => env.BACKUP_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || '';

function toAlertStatus(status: GithubStatus | null): AlertStatus | null {
  return status ? { latest: status.latest ? { key: status.latest.id, uploaded: status.latest.published } : null, dailyCount: status.dailyCount, monthlyCount: status.monthlyCount, totalBytes: status.totalBytes } : null;
}

function alerter(env: GithubEnv, deps: GithubDeps, date: string, mode: GithubRunResult['mode']) {
  const sent: string[] = [];
  const undelivered: string[] = [];
  const required = env.BACKUP_ENV?.trim() === 'production';
  const context = { env: env.BACKUP_ENV?.trim() || 'unknown', database: env.BACKUP_DATABASE_NAME?.trim() || 'D1', backend: 'GitHub Releases' };
  return {
    sent,
    async alert(kind: string, status: GithubStatus | null = null, idempotencyKey?: string) {
      sent.push(kind);
      try {
        const state = await sendBackupAlert(env, context, deps, { kind, date, status: toAlertStatus(status), idempotencyKey: idempotencyKey ?? date });
        if (state !== 'sent' && required) undelivered.push(kind);
      } catch {
        undelivered.push(kind);
      }
    },
    /** V produkci chybějící / nedoručené upozornění = chyba běhu (záloha zůstává uložená). */
    finish<T>(result: T): T {
      if (mode !== 'alert-test' && required && !alertsConfigured(env)) {
        deps.log('d1-backup: alerts not configured (RESEND_API_KEY, CONFLICT_ALERT_EMAIL) – produkce bez upozornění');
        throw new BackupError('alerts-not-configured');
      }
      if (undelivered.length > 0) throw new BackupError('alert-delivery-failed');
      return result;
    },
  };
}

function config(env: GithubEnv, purpose: 'backup' | 'monitor', deps: GithubDeps): BackupConfig {
  const { config, errors } = parseBackupConfig(env, { backend: 'github', purpose });
  if (!config) {
    deps.log(`d1-backup: invalid configuration (${errors.join('; ')})`);
    throw new BackupError('not-configured');
  }
  return config;
}

function client(cfg: BackupConfig, env: GithubEnv, deps: GithubDeps) {
  return new GithubClient({ owner: cfg.github!.owner, repo: cfg.github!.repo, database: cfg.databaseName, environment: cfg.environment }, token(env), deps);
}

/** Test doručení upozornění – na D1 ani GitHub nesahá. */
export async function runAlertTest(env: GithubEnv, deps: GithubDeps, runId: string): Promise<GithubRunResult> {
  const date = utcDate(deps.now());
  if (!alertsConfigured(env)) throw new BackupError('alerts-not-configured');
  const alerts = alerter(env, deps, date, 'alert-test');
  await alerts.alert('alert-test', null, runId);
  return alerts.finish({ mode: 'alert-test', date, status: null, alerts: alerts.sent });
}

/** Denní záloha do GitHub Releases. */
export async function runGithubBackup(env: GithubEnv, deps: GithubDeps): Promise<GithubRunResult> {
  const now = deps.now();
  const date = utcDate(now);
  const alerts = alerter(env, deps, date, 'backup');
  let result: Omit<GithubRunResult, 'status' | 'alerts'>;
  let gh: GithubClient;
  let cfg: BackupConfig;
  try {
    cfg = config(env, 'backup', deps);
    gh = client(cfg, env, deps);
    await gh.assertPrivateRepository('write');
    const daily: SnapshotRef = { type: 'daily', date };
    const monthly: SnapshotRef = { type: 'monthly', date: monthOf(date) };

    // Dnešní snapshot už existuje (opakovaný běh) → bez nového exportu, jen ověření.
    let dailyState: 'stored' | 'exists';
    let sealed: { bytes: Uint8Array; manifest: ReturnType<typeof buildManifest> };
    const existingDaily = await gh.releaseByTag(releaseTag(gh.target, daily));
    if (existingDaily) {
      const snapshot = identifySnapshot(gh.target, existingDaily);
      if (!snapshot) throw new BackupError('snapshot-conflict');
      sealed = await downloadSnapshot(gh, snapshot);
      dailyState = 'exists';
    } else {
      const exported = await exportVerified(
        { accountId: cfg.accountId, databaseId: cfg.databaseId, databaseName: cfg.databaseName, environment: cfg.environment, schemaProfile: cfg.schemaProfile, apiToken: env.D1_EXPORT_API_TOKEN?.trim() ?? '', maxExportBytes: cfg.maxExportBytes },
        { ...deps, now: deps.now },
      );
      const file = await sealSnapshot(exported.sql, cfg.encryption);
      // Produkční SQL nikdy nešifrované (config to vynucuje; pojistka i zde).
      if (cfg.environment === 'production' && file.encryption !== 'age') throw new BackupError('encryption-not-configured');
      const manifest = buildManifest({
        database: cfg.databaseName,
        environment: cfg.environment,
        schemaProfile: cfg.schemaProfile,
        snapshot: daily,
        exportedAt: exported.exportedAt,
        bookmark: exported.bookmark,
        migrations: exported.migrations,
        sql: { bytes: exported.bytes, sha256: exported.sha256 },
        file: { name: `${snapshotBaseName(cfg.databaseName, cfg.environment, daily)}${file.extension}`, bytes: file.bytes.length, sha256: file.sha256, compression: file.compression, encryption: file.encryption, recipients: file.encryption === 'age' ? cfg.encryption.recipients : [] },
      });
      exported.sql.fill(0);
      const state = await publishSnapshot(gh, daily, file.bytes, manifest, 'verify');
      dailyState = state === 'stored' ? 'stored' : 'exists';
      sealed = { bytes: file.bytes, manifest };
    }

    // Měsíční = první úspěšná záloha měsíce (stejný ověřený soubor); existující zůstává.
    let monthlyState: PublishState;
    const existingMonthly = await gh.releaseByTag(releaseTag(gh.target, monthly));
    if (existingMonthly) {
      const snapshot = identifySnapshot(gh.target, existingMonthly);
      if (!snapshot) throw new BackupError('snapshot-conflict');
      await downloadSnapshot(gh, snapshot);
      monthlyState = 'kept';
    }
    else {
      const name = `${snapshotBaseName(cfg.databaseName, cfg.environment, monthly)}${sealed.manifest.file.name.endsWith('.age') ? '.sql.gz.age' : '.sql.gz'}`;
      monthlyState = await publishSnapshot(gh, monthly, sealed.bytes, manifestFor(sealed.manifest, monthly, name), 'keep');
    }
    result = { mode: 'backup', date, daily: dailyState, monthly: monthlyState, bytes: sealed.bytes.length };
  } catch (error) {
    const kind = errorKind(error);
    deps.log(`d1-backup: backup failed (${kind})`);
    await alerts.alert(`backup-failed:${kind}`);
    throw error;
  }

  // Retence až po úspěšné záloze; chyba retence zálohu nezneplatní, ale běh skončí chybou.
  let retentionError: unknown = null;
  try {
    result.pruned = await applyRetention(gh, cfg.keepDaily, cfg.keepMonthly, now);
  } catch (error) {
    retentionError = error;
    deps.log(`d1-backup: retention failed (${errorKind(error)})`);
    await alerts.alert(`retention-failed:${errorKind(error)}`);
  }
  let status: GithubStatus | null = null;
  try {
    status = await githubStatus(gh, deps.now(), STALE_AFTER_MS);
  } catch (error) {
    deps.log(`d1-backup: status check failed (${errorKind(error)})`);
  }
  deps.log(`d1-backup: ok (${result.daily}, monthly ${result.monthly}, ${result.bytes} B${status ? `, ${status.dailyCount} denních, ${status.monthlyCount} měsíčních` : ''})`);
  const final = alerts.finish({ ...result, status, alerts: alerts.sent });
  if (retentionError) throw new BackupError('retention-failed');
  return final;
}

/** Kontrola stáří poslední denní zálohy (stačí token jen pro čtení). */
export async function runGithubMonitor(env: GithubEnv, deps: GithubDeps): Promise<GithubRunResult> {
  const date = utcDate(deps.now());
  const alerts = alerter(env, deps, date, 'monitor');
  let status: GithubStatus;
  try {
    const cfg = config(env, 'monitor', deps);
    const gh = client(cfg, env, deps);
    await gh.assertPrivateRepository('read');
    status = await githubStatus(gh, deps.now(), STALE_AFTER_MS, true);
  } catch (error) {
    const kind = errorKind(error);
    deps.log(`d1-backup: monitor failed (${kind})`);
    await alerts.alert(`monitor-failed:${kind}`);
    throw error;
  }
  if (status.stale) await alerts.alert('backup-stale', status);
  return alerts.finish({ mode: 'monitor', date, status, alerts: alerts.sent });
}
