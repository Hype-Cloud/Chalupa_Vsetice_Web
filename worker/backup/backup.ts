// Úložiště R2 (Cloudflare Workers): streaming exportu do R2, podmíněný zápis snapshotů, retence
// a kontrola kapacity. Export, kontrola SQL a chyby jsou ve společném jádru lib/backup/core.ts.
//
// - Stažení: podepsaná URL se streamuje přes FixedLengthStream (délka z Content-Length –
//   zkrácený přenos selže) do R2 `pending/<instance>.sql`; cestou MD5 a SqlInspector. MD5 se
//   porovná s kontrolním součtem uloženým v R2.
// - Teprve ověřený soubor se zkopíruje podmíněným zápisem (If-None-Match: *, R2 znovu ověří MD5)
//   do `daily/YYYY-MM-DD.sql`, první úspěšná záloha měsíce i do `monthly/YYYY-MM.sql`.
//   Existující snapshot se nikdy nepřepisuje.
// - Retence podle počtu jen po úspěšné záloze – neúspěšné běhy nic nemažou.
// - Do logu jen druh chyby: nikdy token, podepsaná URL, obsah SQL ani odpovědi API.

import { BackupError, hex, openExportDownload, requestExport, SqlInspector, type CoreDeps, type ExportConfig } from '../../lib/backup/core.ts';

export { BackupError, MAX_POLLS, POLL_INTERVAL_MS, SqlInspector, STALE_AFTER_MS, utcDate, type ExportConfig } from '../../lib/backup/core.ts';
export { DEFAULT_KEEP_DAILY as KEEP_DAILY, DEFAULT_KEEP_MONTHLY as KEEP_MONTHLY } from '../../lib/backup/core.ts';
import { STALE_AFTER_MS } from '../../lib/backup/core.ts';

export const DAILY_PREFIX = 'daily/';
export const MONTHLY_PREFIX = 'monthly/';
export const PENDING_PREFIX = 'pending/';
/** Upozornění při objemu záloh nad 7 GB (dekadicky; bezplatná kvóta R2 Standard je 10 GB-month). */
export const STORAGE_ALERT_BYTES = 7 * 1000 ** 3;
/**
 * Strop velikosti jednoho exportu pro R2 (150 MiB; produkční export má řádově kB) – R2 nemá
 * tvrdý strop účtování, proto je konfigurovatelný strop (BACKUP_MAX_EXPORT_BYTES) pro R2 shora
 * omezen touto hodnotou.
 */
export const MAX_EXPORT_BYTES = 150 * 1024 ** 2;
/**
 * Tvrdý strop objemu bucketu: nová záloha se nezačne, pokud by objem (všechny objekty bucketu
 * včetně cizích a pending/) mohl s rezervou 3 × MAX_EXPORT_BYTES překročit 9 GB. Drží zálohy pod
 * bezplatnou kvótou R2 (10 GB-month) s rezervou na souběžný běh. Nezahrnuje jiné buckety účtu.
 */
export const STORAGE_HARD_LIMIT_BYTES = 9 * 1000 ** 3;

const DAILY_KEY = /^daily\/(\d{4}-\d{2}-\d{2})\.sql$/;
const MONTHLY_KEY = /^monthly\/(\d{4}-\d{2})\.sql$/;
export type BackupBucket = Pick<R2Bucket, 'head' | 'get' | 'put' | 'list' | 'delete'>;

/** Streamové primitivy runtime (ve Workers DigestStream a FixedLengthStream). */
export interface StreamPrimitives {
  md5(): { writable: WritableStream<Uint8Array>; digest: Promise<ArrayBuffer> };
  fixedLength(length: number): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
}

export const workersStreams: StreamPrimitives = {
  md5: () => {
    // Ve Workers je DigestStream na `crypto` (typy DOM ho neznají).
    const stream = new (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream('MD5');
    return { writable: stream, digest: stream.digest };
  },
  fixedLength: (length) => new FixedLengthStream(length),
};

export interface BackupDeps extends CoreDeps {
  bucket: BackupBucket;
  streams: StreamPrimitives;
  now: () => Date;
}

/** Výsledek uložení do pending/ – jen metadata (žádná URL ani obsah). */
export interface PendingExport {
  key: string;
  bytes: number;
  md5: string;
  /** Time Travel bookmark stavu, ze kterého export vznikl. */
  bookmark: string;
  migrations: number;
}

export const dailyKey = (date: string) => `${DAILY_PREFIX}${date}.sql`;
export const monthlyKey = (date: string) => `${MONTHLY_PREFIX}${date.slice(0, 7)}.sql`;
export const pendingKey = (instanceId: string) => `${PENDING_PREFIX}${instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}.sql`;

// --- Export → R2 pending/ ----------------------------------------------------------------------

/** Stáhne hotový export a streamuje ho do R2 `key` s kontrolou délky, MD5 a struktury. */
export async function downloadToPending(config: ExportConfig, deps: BackupDeps, signedUrl: string, key: string): Promise<Omit<PendingExport, 'bookmark'>> {
  const { body, length } = await openExportDownload({ maxExportBytes: Math.min(config.maxExportBytes, MAX_EXPORT_BYTES) }, deps, signedUrl);

  const inspector = new SqlInspector(config.environment);
  const md5 = deps.streams.md5();
  const md5Writer = md5.writable.getWriter();
  let bytes = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      bytes += chunk.byteLength;
      inspector.push(chunk);
      await md5Writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      inspector.finish();
      await md5Writer.close();
    },
  });
  const fixed = deps.streams.fixedLength(length);
  const piping = body.pipeThrough(tap).pipeTo(fixed.writable);
  let stored: R2Object | null;
  try {
    [stored] = await Promise.all([
      deps.bucket.put(key, fixed.readable, {
        httpMetadata: { contentType: 'application/sql' },
        customMetadata: { state: 'pending', database: config.databaseName, environment: config.environment },
      }),
      piping,
    ]);
  } catch {
    await md5Writer.abort().catch(() => undefined);
    throw new BackupError('upload-failed');
  }
  const digest = hex(await md5.digest);
  const storedMd5 = stored?.checksums.md5 ? hex(stored.checksums.md5) : null;
  const problems = inspector.problems();
  let kind: string | null = null;
  if (!stored || stored.size !== length || bytes !== length || stored.size === 0) kind = 'size-mismatch';
  else if (storedMd5 !== digest) kind = 'integrity-mismatch';
  else if (problems.length > 0) kind = 'invalid-export';
  if (kind) {
    if (problems.length > 0) deps.log(`d1-backup: export check failed (${problems.join(',')})`);
    await deps.bucket.delete(key).catch(() => undefined);
    throw new BackupError(kind);
  }
  return { key, bytes, md5: digest, migrations: inspector.migrations };
}

/** Celý export do pending/: vyžádání, dotazování, stažení a ověření. */
export async function exportToPending(config: ExportConfig, deps: BackupDeps, key: string): Promise<PendingExport> {
  const { bookmark, signedUrl } = await requestExport(config, deps);
  const pending = await downloadToPending(config, deps, signedUrl, key);
  return { ...pending, bookmark };
}

// --- Povýšení na snapshot, retence, objem ------------------------------------------------------

export interface SnapshotMetadata {
  database: string;
  environment: string;
  bookmark: string;
  createdAt: string;
  migrations: number;
}

/**
 * Co dělat, když cílový klíč už existuje:
 * - `verify` (denní snapshot): stejná velikost a MD5 = idempotentní úspěch (`exists`), jiný
 *   obsah = kolize (`snapshot-conflict`) – existující objekt zůstává beze změny;
 * - `keep` (měsíční snapshot = první úspěšná záloha měsíce): existující objekt se ponechá vždy;
 *   `exists` při shodném obsahu, `kept` při jiném (starší záloha téhož měsíce).
 */
export type ExistingPolicy = 'verify' | 'keep';

/** Podmíněný zápis „jen když klíč neexistuje“ (R2 put s If-None-Match: *; neúspěch = null). */
const CREATE_ONLY = () => new Headers({ 'if-none-match': '*' });

/**
 * Zkopíruje ověřený objekt `source` do `target` atomickým podmíněným zápisem: R2 objekt uloží jen
 * tehdy, když `target` neexistuje (`If-None-Match: *`), a při zápisu ověří MD5. Existující
 * snapshot tak nepřepíše ani souběžná instance – rozhoduje R2, ne předchozí `head()`.
 */
export async function copySnapshot(
  bucket: BackupBucket,
  source: string,
  target: string,
  expected: { bytes: number; md5: string },
  metadata: SnapshotMetadata,
  policy: ExistingPolicy = 'verify',
): Promise<'stored' | 'exists' | 'kept'> {
  const object = await bucket.get(source);
  if (!object) throw new BackupError('source-missing');
  if (object.size !== expected.bytes) {
    await object.body.cancel().catch(() => undefined);
    throw new BackupError('integrity-mismatch');
  }
  let stored: R2Object | null;
  try {
    stored = await bucket.put(target, object.body, {
      onlyIf: CREATE_ONLY(),
      md5: expected.md5,
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { ...metadata, migrations: String(metadata.migrations), md5: expected.md5, bytes: String(expected.bytes) },
    });
  } catch {
    throw new BackupError('upload-failed');
  }
  if (stored) {
    if (stored.size !== expected.bytes) throw new BackupError('size-mismatch');
    return 'stored';
  }
  // Podmínka selhala: klíč už existuje (jiná instance nebo dřívější běh). Nic se nepřepsalo –
  // existující objekt se jen ověří.
  await object.body.cancel().catch(() => undefined);
  const existing = await bucket.head(target);
  const same = !!existing && existing.size === expected.bytes && !!existing.checksums.md5 && hex(existing.checksums.md5) === expected.md5;
  if (same) return 'exists';
  if (policy === 'keep' && existing) return 'kept';
  throw new BackupError('snapshot-conflict');
}

async function listAll(bucket: BackupBucket, prefix?: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/**
 * Retence podle počtu: ponechá `keep` nejnovějších snapshotů s názvem podle `pattern`, starší
 * smaže. Jiné objekty pod prefixem nechá být. Volat jen po úspěšné záloze.
 */
export async function pruneSnapshots(bucket: BackupBucket, prefix: string, pattern: RegExp, keep: number): Promise<string[]> {
  const keys = (await listAll(bucket, prefix)).map((o) => o.key).filter((key) => pattern.test(key)).sort().reverse();
  const remove = keys.slice(keep);
  if (remove.length > 0) await bucket.delete(remove);
  return remove;
}

export const pruneDaily = (bucket: BackupBucket, keep: number) => pruneSnapshots(bucket, DAILY_PREFIX, DAILY_KEY, keep);
export const pruneMonthly = (bucket: BackupBucket, keep: number) => pruneSnapshots(bucket, MONTHLY_PREFIX, MONTHLY_KEY, keep);

/** Smaže pozůstatky neúspěšných běhů v pending/ starší než 24 h (kromě `keepKey`). */
export async function cleanPending(bucket: BackupBucket, now: Date, keepKey?: string): Promise<number> {
  const stale = (await listAll(bucket, PENDING_PREFIX)).filter((o) => o.key !== keepKey && now.getTime() - o.uploaded.getTime() > 24 * 60 * 60 * 1000).map((o) => o.key);
  if (stale.length > 0) await bucket.delete(stale);
  return stale.length;
}

export interface BackupStatus {
  /** Nejnovější denní snapshot, nebo null. */
  latest: { key: string; uploaded: string } | null;
  ageMs: number | null;
  stale: boolean;
  dailyCount: number;
  monthlyCount: number;
  totalBytes: number;
  nearLimit: boolean;
}

/** Stav záloh: stáří poslední denní zálohy a celkový objem bucketu. */
export async function backupStatus(bucket: BackupBucket, now: Date): Promise<BackupStatus> {
  const objects = await listAll(bucket);
  const daily = objects.filter((o) => DAILY_KEY.test(o.key)).sort((a, b) => b.key.localeCompare(a.key));
  const latest = daily[0] ?? null;
  const ageMs = latest ? now.getTime() - latest.uploaded.getTime() : null;
  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
  return {
    latest: latest ? { key: latest.key, uploaded: latest.uploaded.toISOString() } : null,
    ageMs,
    stale: ageMs === null || ageMs > STALE_AFTER_MS,
    dailyCount: daily.length,
    monthlyCount: objects.filter((o) => MONTHLY_KEY.test(o.key)).length,
    totalBytes,
    nearLimit: totalBytes > STORAGE_ALERT_BYTES,
  };
}
