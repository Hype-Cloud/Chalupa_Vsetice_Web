// Konfigurace zálohování – stejné proměnné pro CLI, GitHub Actions i Cloudflare Workflows.
//
// Necitlivé hodnoty (BACKUP_*) jsou v konfiguraci workflow nebo wrangleru; credentials
// (D1_EXPORT_API_TOKEN, GITHUB_TOKEN, RESEND_API_KEY, …) jen v GitHub Actions Secrets,
// Cloudflare Secrets nebo lokálním prostředí – nikdy v souborech verzovaných Gitem.
// Hodnoty, které daný backend nebo operace nepotřebuje, nejsou povinné.

import { DEFAULT_KEEP_DAILY, DEFAULT_KEEP_MONTHLY, DEFAULT_MAX_EXPORT_BYTES } from './core.ts';

export type BackupBackend = 'github' | 'r2';
export type BackupEnvironment = 'production' | 'preview';
/** Co konfigurace musí umožnit: záloha (export + zápis), čtení (výpis, stažení), kontrola stáří. */
export type BackupPurpose = 'backup' | 'read' | 'monitor';

export interface BackupConfig {
  backend: BackupBackend;
  environment: BackupEnvironment;
  databaseName: string;
  /** Jen pro export (purpose backup). */
  databaseId: string;
  accountId: string;
  keepDaily: number;
  keepMonthly: number;
  maxExportBytes: number;
  github: { owner: string; repo: string } | null;
  r2: { bucket: string } | null;
  encryption: { mode: 'age' | 'none'; recipients: string[] };
}

/** GitHub release asset musí být pod 2 GiB; šifrovaný gzip je nejvýš o málo větší než SQL. */
export const GITHUB_MAX_EXPORT_BYTES = 1024 ** 3;
/** R2 nemá tvrdý strop účtování – strop exportu drží nejhorší objem pod bezplatnou kvótou. */
export const R2_MAX_EXPORT_BYTES = 150 * 1024 ** 2;

const DATABASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** age X25519 (`age1…`) i hybridní post-kvantový (`age1pq1…`) příjemce, bech32 malými písmeny. */
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{50,}$/;

/** `owner/repo` nebo `https://github.com/owner/repo(.git)`; jinak null. */
export function parseGithubRepo(value: string): { owner: string; repo: string } | null {
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash) return null;
    path = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  }
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number, errors: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    errors.push(`${name} musí být celé číslo`);
    return fallback;
  }
  const n = Number(value);
  if (n < min || n > max) errors.push(`${name} musí být v rozsahu ${min}–${max}`);
  return n;
}

/**
 * Načte a ověří konfiguraci z prostředí. Chyby jsou popisné, ale nikdy neobsahují hodnoty
 * proměnných (mohly by být omylem credentials).
 */
export function parseBackupConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { backend?: BackupBackend; purpose: BackupPurpose },
): { config: BackupConfig | null; errors: string[] } {
  const errors: string[] = [];
  const get = (name: string) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const rawBackend = get('BACKUP_BACKEND');
  let backend: BackupBackend | undefined = options.backend;
  if (rawBackend !== undefined) {
    if (rawBackend !== 'github' && rawBackend !== 'r2') errors.push('BACKUP_BACKEND musí být "github" nebo "r2"');
    else if (options.backend && rawBackend !== options.backend) errors.push(`BACKUP_BACKEND "${rawBackend}" neodpovídá tomuto spouštěči (${options.backend})`);
    else backend = rawBackend;
  }
  if (!backend) errors.push('chybí BACKUP_BACKEND ("github" nebo "r2") – přepnutí backendu musí být explicitní');

  const rawEnv = get('BACKUP_ENV');
  const environment = rawEnv === 'production' || rawEnv === 'preview' ? rawEnv : undefined;
  if (!environment) errors.push('BACKUP_ENV musí být "production" nebo "preview"');

  const databaseName = get('BACKUP_DATABASE_NAME') ?? '';
  if (!DATABASE_NAME.test(databaseName) || databaseName.length > 64) errors.push('BACKUP_DATABASE_NAME musí být název D1 (malá písmena, číslice, jednoduché pomlčky, max. 64 znaků)');

  const needsExport = options.purpose === 'backup';
  const databaseId = get('BACKUP_DATABASE_ID') ?? '';
  const accountId = get('BACKUP_CLOUDFLARE_ACCOUNT_ID') ?? '';
  if (needsExport && !UUID.test(databaseId)) errors.push('BACKUP_DATABASE_ID musí být UUID databáze D1');
  // Účet potřebuje export a čtení z R2 přes REST API (CLI); GitHub čtení ani Worker s bindingem ne.
  const needsAccount = needsExport || (backend === 'r2' && options.purpose === 'read');
  if (needsAccount && !ACCOUNT_ID.test(accountId)) errors.push('BACKUP_CLOUDFLARE_ACCOUNT_ID musí být 32 hexadecimálních znaků');

  const keepDaily = integer(env.BACKUP_KEEP_DAILY, 'BACKUP_KEEP_DAILY', DEFAULT_KEEP_DAILY, 1, 366, errors);
  const keepMonthly = integer(env.BACKUP_KEEP_MONTHLY, 'BACKUP_KEEP_MONTHLY', DEFAULT_KEEP_MONTHLY, 0, 120, errors);
  const maxBytesLimit = backend === 'r2' ? R2_MAX_EXPORT_BYTES : GITHUB_MAX_EXPORT_BYTES;
  const maxExportBytes = integer(env.BACKUP_MAX_EXPORT_BYTES, 'BACKUP_MAX_EXPORT_BYTES', Math.min(DEFAULT_MAX_EXPORT_BYTES, maxBytesLimit), 1024, maxBytesLimit, errors);

  let github: BackupConfig['github'] = null;
  if (backend === 'github') {
    const raw = get('BACKUP_GITHUB_REPO');
    github = raw ? parseGithubRepo(raw) : null;
    if (!github) errors.push('BACKUP_GITHUB_REPO musí být "owner/repo" nebo https://github.com/owner/repo');
  }

  let r2: BackupConfig['r2'] = null;
  if (backend === 'r2') {
    const bucket = get('BACKUP_R2_BUCKET');
    // Worker používá binding; název bucketu potřebuje jen CLI (čtení přes REST API).
    if (bucket !== undefined && !R2_BUCKET.test(bucket)) errors.push('BACKUP_R2_BUCKET není platný název bucketu');
    if (bucket === undefined && options.purpose === 'read') errors.push('chybí BACKUP_R2_BUCKET');
    r2 = bucket ? { bucket } : null;
  }

  const rawEncryption = get('BACKUP_ENCRYPTION') ?? (backend === 'github' ? 'age' : 'none');
  const recipients = (get('BACKUP_AGE_RECIPIENT') ?? '').split(/[\s,]+/).filter(Boolean);
  let mode: 'age' | 'none' = 'none';
  if (rawEncryption !== 'age' && rawEncryption !== 'none') errors.push('BACKUP_ENCRYPTION musí být "age" nebo "none"');
  else mode = rawEncryption;
  if (backend === 'r2' && mode === 'age') errors.push('BACKUP_ENCRYPTION=age zatím R2 backend nepodporuje (R2 šifruje v klidu na straně Cloudflare)');
  if (backend === 'github' && environment === 'production' && mode !== 'age' && options.purpose === 'backup') {
    errors.push('produkční záloha do GitHubu musí být šifrovaná (BACKUP_ENCRYPTION=age)');
  }
  if (mode === 'age' && options.purpose === 'backup') {
    if (recipients.length === 0) errors.push('chybí BACKUP_AGE_RECIPIENT (veřejný klíč age1…)');
    else if (!recipients.every((r) => AGE_RECIPIENT.test(r))) errors.push('BACKUP_AGE_RECIPIENT musí obsahovat jen veřejné klíče age1… (nikdy soukromý klíč)');
  }
  // Soukromý klíč omylem v prostředí automatické zálohy nebo kontroly (CI, Worker): odmítnout.
  if (options.purpose !== 'read' && Object.values(env).some((v) => typeof v === 'string' && /AGE-SECRET-KEY-1/i.test(v))) {
    errors.push('konfigurace obsahuje soukromý klíč age (AGE-SECRET-KEY-…) – nesmí být v prostředí zálohy');
  }

  if (errors.length > 0 || !backend || !environment) return { config: null, errors };
  return {
    config: { backend, environment, databaseName, databaseId, accountId, keepDaily, keepMonthly, maxExportBytes, github, r2, encryption: { mode, recipients } },
    errors,
  };
}
