// Automatická záloha D1 do R2: export přes D1 REST API, streaming do R2 s ověřením, retence.
//
// - Export: POST /accounts/{account}/d1/database/{db}/export (output_format "polling",
//   dump_options.compatibility "d1" = obnovitelný SQL; nikdy "sqlite3_cli_only"). Probíhající
//   export se musí průběžně dotazovat, jinak se zruší – dotazování proto běží v jednom kroku.
//   Tvar odpovědi (ověřeno proti API i wrangleru): result.status "complete" | "error" (chybí =
//   probíhá), result.at_bookmark, result.result.{filename, signed_url}. HTTP 200 samo o sobě
//   úspěch neznamená.
// - Stažení: podepsaná URL (platí 1 h) se streamuje přes FixedLengthStream (délka z
//   Content-Length – zkrácený přenos selže) do R2 `pending/<instance>.sql`. Cestou se počítá MD5
//   a kontroluje struktura SQL (začátek, schéma, záznamy migrací, prostředí v meta, konec
//   příkazem). MD5 se porovná s kontrolním součtem uloženým v R2.
// - Teprve ověřený soubor se zkopíruje (R2 znovu ověří MD5) do `daily/YYYY-MM-DD.sql`, první
//   úspěšná záloha měsíce i do `monthly/YYYY-MM.sql`. Existující snapshot se nikdy nepřepisuje.
// - Retence podle počtu (30 denních, 12 měsíčních) jen po úspěšné záloze – neúspěšné běhy
//   nic nemažou.
// - Do logu jen druh chyby: nikdy token, podepsaná URL, obsah SQL ani odpovědi API.

export const DAILY_PREFIX = 'daily/';
export const MONTHLY_PREFIX = 'monthly/';
export const PENDING_PREFIX = 'pending/';
export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;
/** Upozornění při objemu záloh nad 7 GB (bezplatná kvóta R2 Standard je 10 GB-month). */
export const STORAGE_ALERT_BYTES = 7 * 1024 ** 3;
/** Upozornění, když poslední denní záloha je starší než 48 h. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const MAX_POLLS = 20;
export const POLL_INTERVAL_MS = 2_000;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * Strop velikosti jednoho exportu. Při retenci 30 + 12 snapshotů (+ rozpracovaný pending/) drží
 * objem záloh i v nejhorším případě pod bezplatnou kvótou R2 (44 × 200 MiB ≈ 8,6 GiB < 10 GB).
 * Větší export = chyba a upozornění, ne tiché čerpání placeného úložiště.
 */
export const MAX_EXPORT_BYTES = 200 * 1024 ** 2;

const DAILY_KEY = /^daily\/(\d{4}-\d{2}-\d{2})\.sql$/;
const MONTHLY_KEY = /^monthly\/(\d{4}-\d{2})\.sql$/;
const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;

/** Chyba zálohy s druhem bez citlivých údajů (do logu, upozornění i stavu Workflow). */
export class BackupError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.name = 'BackupError';
    this.kind = kind;
  }
}

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

export interface BackupDeps {
  fetch: typeof fetch;
  bucket: BackupBucket;
  streams: StreamPrimitives;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
}

export interface ExportConfig {
  accountId: string;
  databaseId: string;
  /** Název D1 (metadata snapshotu). */
  databaseName: string;
  /** Očekávaná hodnota meta.environment v exportu (production | preview). */
  environment: string;
  apiToken: string;
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

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

export const dailyKey = (date: string) => `${DAILY_PREFIX}${date}.sql`;
export const monthlyKey = (date: string) => `${MONTHLY_PREFIX}${date.slice(0, 7)}.sql`;
export const pendingKey = (instanceId: string) => `${PENDING_PREFIX}${instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}.sql`;
/** UTC datum YYYY-MM-DD. */
export const utcDate = (date: Date) => date.toISOString().slice(0, 10);

// --- D1 export REST API ------------------------------------------------------------------------

interface ExportState {
  status: 'pending' | 'complete';
  bookmark: string;
  signedUrl?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Jedno volání exportu; vrací ověřený stav, jinak BackupError. */
async function callExport(config: ExportConfig, deps: BackupDeps, bookmark?: string): Promise<ExportState> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/export`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ output_format: 'polling', dump_options: { compatibility: 'd1' }, ...(bookmark ? { current_bookmark: bookmark } : {}) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BackupError(error instanceof Error && error.name === 'TimeoutError' ? 'api-timeout' : 'api-network');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BackupError(`api-http-${response.status}`);
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new BackupError('api-invalid-response');
  }
  if (!isObject(envelope) || envelope.success !== true || !isObject(envelope.result)) throw new BackupError('api-invalid-response');
  const result = envelope.result;
  if (result.status === 'error' || result.success === false) throw new BackupError('export-failed');
  const at = result.at_bookmark;
  if (typeof at !== 'string' || !BOOKMARK.test(at)) throw new BackupError('api-invalid-response');
  if (bookmark && at !== bookmark) throw new BackupError('api-invalid-response');
  if (result.status === undefined) return { status: 'pending', bookmark: at };
  if (result.status !== 'complete') throw new BackupError('api-invalid-response');
  const signed = isObject(result.result) ? result.result.signed_url : undefined;
  let signedUrl: URL;
  try {
    signedUrl = new URL(String(signed));
  } catch {
    throw new BackupError('api-invalid-response');
  }
  if (typeof signed !== 'string' || signedUrl.protocol !== 'https:') throw new BackupError('api-invalid-response');
  return { status: 'complete', bookmark: at, signedUrl: signed };
}

/** Spustí export a dotazuje se, dokud není hotový (nejvýš MAX_POLLS × POLL_INTERVAL_MS). */
export async function requestExport(config: ExportConfig, deps: BackupDeps): Promise<{ bookmark: string; signedUrl: string }> {
  let state = await callExport(config, deps);
  for (let poll = 0; state.status === 'pending'; poll++) {
    if (poll >= MAX_POLLS) throw new BackupError('export-timeout');
    await deps.sleep(POLL_INTERVAL_MS);
    state = await callExport(config, deps, state.bookmark);
  }
  return { bookmark: state.bookmark, signedUrl: state.signedUrl! };
}

// --- Kontrola obsahu SQL při streamování -------------------------------------------------------

const MARKERS = {
  migrationsSchema: /CREATE TABLE (?:IF NOT EXISTS )?"?d1_migrations"?\s*\(/,
  reservationsSchema: /CREATE TABLE (?:IF NOT EXISTS )?"?reservations"?\s*\(/,
};
const MIGRATION_ROW = /INSERT INTO "?d1_migrations"? /g;
const CARRY = 256;

/** Postupná kontrola struktury exportu bez načtení celého souboru do paměti. */
export class SqlInspector {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private head = '';
  private carry = '';
  private lastChar = '';
  private found = new Set<string>();
  private environmentFound = false;
  private invalidUtf8 = false;
  migrations = 0;
  private readonly environment: string;

  constructor(environment: string) {
    this.environment = environment;
  }

  push(chunk: Uint8Array, final = false): void {
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: !final });
    } catch {
      this.invalidUtf8 = true;
      return;
    }
    if (this.head.length < 64) this.head += text.slice(0, 64 - this.head.length);
    const window = this.carry + text;
    for (const [name, pattern] of Object.entries(MARKERS)) if (!this.found.has(name) && pattern.test(window)) this.found.add(name);
    if (!this.environmentFound && window.includes(`VALUES('environment','${this.environment}')`)) this.environmentFound = true;
    // Záznam migrace se počítá jen jednou: musí zasahovat do nového textu (konec za carry).
    for (const match of window.matchAll(MIGRATION_ROW)) if (match.index + match[0].length > this.carry.length) this.migrations++;
    const trimmed = text.trimEnd();
    if (trimmed) this.lastChar = trimmed.at(-1)!;
    this.carry = window.slice(-CARRY);
  }

  finish(): void {
    this.push(new Uint8Array(), true);
  }

  /** Důvody neplatnosti (prázdné = struktura odpovídá obnovitelnému exportu D1). */
  problems(): string[] {
    const problems: string[] = [];
    if (this.invalidUtf8) problems.push('not-utf8');
    if (!this.head.startsWith('PRAGMA defer_foreign_keys=TRUE;')) problems.push('unexpected-start');
    for (const name of Object.keys(MARKERS)) if (!this.found.has(name)) problems.push(`missing-${name}`);
    if (this.migrations === 0) problems.push('missing-migration-rows');
    if (!this.environmentFound) problems.push('environment-mismatch');
    if (this.lastChar !== ';') problems.push('truncated');
    return problems;
  }
}

// --- Export → R2 pending/ ----------------------------------------------------------------------

/** Stáhne hotový export a streamuje ho do R2 `key` s kontrolou délky, MD5 a struktury. */
export async function downloadToPending(config: ExportConfig, deps: BackupDeps, signedUrl: string, key: string): Promise<Omit<PendingExport, 'bookmark'>> {
  let response: Response;
  try {
    response = await deps.fetch(signedUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new BackupError(error instanceof Error && error.name === 'TimeoutError' ? 'download-timeout' : 'download-network');
  }
  // 403/404 = podepsaná URL vypršela nebo neplatí – nový pokus kroku vytvoří nový export.
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new BackupError(`download-http-${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_EXPORT_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new BackupError(length > MAX_EXPORT_BYTES ? 'export-too-large' : 'download-no-length');
  }

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
  const piping = response.body.pipeThrough(tap).pipeTo(fixed.writable);
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
  if (!config.apiToken || !config.accountId || !config.databaseId) throw new BackupError('not-configured');
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
 * Zkopíruje ověřený objekt `source` do `target` (R2 při zápisu ověří MD5). Existující `target`
 * se nikdy nepřepisuje: stejný obsah = hotovo (opakovaný pokus), jiný = chyba.
 */
export async function copySnapshot(bucket: BackupBucket, source: string, target: string, expected: { bytes: number; md5: string }, metadata: SnapshotMetadata): Promise<'stored' | 'exists'> {
  const existing = await bucket.head(target);
  if (existing) {
    if (existing.size === expected.bytes && existing.checksums.md5 && hex(existing.checksums.md5) === expected.md5) return 'exists';
    throw new BackupError('snapshot-exists');
  }
  const object = await bucket.get(source);
  if (!object) throw new BackupError('source-missing');
  if (object.size !== expected.bytes) {
    await object.body.cancel().catch(() => undefined);
    throw new BackupError('integrity-mismatch');
  }
  let stored: R2Object | null;
  try {
    stored = await bucket.put(target, object.body, {
      md5: expected.md5,
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { ...metadata, migrations: String(metadata.migrations), md5: expected.md5, bytes: String(expected.bytes) },
    });
  } catch {
    throw new BackupError('upload-failed');
  }
  if (!stored || stored.size !== expected.bytes) throw new BackupError('size-mismatch');
  return 'stored';
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

export const pruneDaily = (bucket: BackupBucket) => pruneSnapshots(bucket, DAILY_PREFIX, DAILY_KEY, KEEP_DAILY);
export const pruneMonthly = (bucket: BackupBucket) => pruneSnapshots(bucket, MONTHLY_PREFIX, MONTHLY_KEY, KEEP_MONTHLY);

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
