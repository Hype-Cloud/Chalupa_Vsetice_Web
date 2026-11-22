// Společné jádro zálohování D1 – nezávislé na úložišti i runtime (Node.js, Cloudflare Workers).
//
// - Export přes oficiální D1 REST API: POST /accounts/{account}/d1/database/{db}/export,
//   output_format "polling", dump_options.compatibility "d1" (obnovitelný SQL; nikdy
//   "sqlite3_cli_only"). Probíhající export se musí průběžně dotazovat, jinak se zruší.
//   Tvar odpovědi (ověřeno proti API reference, wrangleru i skutečnému volání): result.status
//   "complete" | "error" (chybí = probíhá), result.at_bookmark, result.result.{filename,
//   signed_url}. HTTP 200 samo o sobě úspěch neznamená.
// - Stažení podepsané URL (platí 1 h) s povinnou Content-Length a stropem velikosti.
// - SqlInspector: postupná kontrola struktury exportu (začátek, schéma, záznamy migrací,
//   prostředí v meta, ukončení příkazem) bez načtení souboru do paměti.
// - Chyby jen jako druh (BackupError.kind) – nikdy token, podepsaná URL, SQL ani odpověď API.
// Runtime-specifické části (fetch, čekání, log) dodává volající.

export const MAX_POLLS = 20;
export const POLL_INTERVAL_MS = 2_000;
/** Výchozí strop velikosti jednoho exportu (konfigurace BACKUP_MAX_EXPORT_BYTES). */
export const DEFAULT_MAX_EXPORT_BYTES = 150 * 1024 ** 2;
export const DEFAULT_KEEP_DAILY = 30;
export const DEFAULT_KEEP_MONTHLY = 12;
/** Upozornění, když poslední denní záloha je starší než 48 h. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;

/** Chyba zálohy s druhem bez citlivých údajů (do logu, upozornění i stavu běhu). */
export class BackupError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.name = 'BackupError';
    this.kind = kind;
  }
}

export const errorKind = (error: unknown) => (error instanceof BackupError ? error.kind : 'unknown');

export interface CoreDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
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
  maxExportBytes: number;
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const hex = (buffer: ArrayBuffer | Uint8Array) => Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
/** UTC datum YYYY-MM-DD. */
export const utcDate = (date: Date) => date.toISOString().slice(0, 10);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

// --- D1 export REST API ------------------------------------------------------------------------

interface ExportState {
  status: 'pending' | 'complete';
  bookmark: string;
  signedUrl?: string;
}

/** Jedno volání exportu; vrací ověřený stav, jinak BackupError. */
async function callExport(config: ExportConfig, deps: CoreDeps, bookmark?: string): Promise<ExportState> {
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
export async function requestExport(config: ExportConfig, deps: CoreDeps): Promise<{ bookmark: string; signedUrl: string }> {
  if (!config.apiToken || !config.accountId || !config.databaseId) throw new BackupError('not-configured');
  let state = await callExport(config, deps);
  for (let poll = 0; state.status === 'pending'; poll++) {
    if (poll >= MAX_POLLS) throw new BackupError('export-timeout');
    await deps.sleep(POLL_INTERVAL_MS);
    state = await callExport(config, deps, state.bookmark);
  }
  return { bookmark: state.bookmark, signedUrl: state.signedUrl! };
}

/**
 * Otevře stažení hotového exportu: povinná Content-Length v rozsahu (0, maxBytes].
 * 403/404 = podepsaná URL vypršela – nový pokus musí vytvořit nový export.
 */
export async function openExportDownload(config: Pick<ExportConfig, 'maxExportBytes'>, deps: Pick<CoreDeps, 'fetch'>, signedUrl: string): Promise<{ body: ReadableStream<Uint8Array>; length: number }> {
  let response: Response;
  try {
    response = await deps.fetch(signedUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new BackupError(error instanceof Error && error.name === 'TimeoutError' ? 'download-timeout' : 'download-network');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new BackupError(`download-http-${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0 || length > config.maxExportBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new BackupError(length > config.maxExportBytes ? 'export-too-large' : 'download-no-length');
  }
  return { body: response.body, length };
}

// --- Kontrola obsahu SQL -----------------------------------------------------------------------

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

/** Ověřená struktura celého SQL v paměti (CLI, GitHub backend); problémy nebo počet migrací. */
export function inspectSql(sql: Uint8Array, environment: string): { problems: string[]; migrations: number } {
  const inspector = new SqlInspector(environment);
  inspector.push(sql);
  inspector.finish();
  return { problems: inspector.problems(), migrations: inspector.migrations };
}

export interface VerifiedExport {
  sql: Uint8Array;
  bytes: number;
  sha256: string;
  bookmark: string;
  migrations: number;
  exportedAt: string;
}

/**
 * Celý export do paměti (pro backendy, které soubor dál zpracují – komprese, šifrování):
 * vyžádání, dotazování, stažení se stropem, kontrola délky, struktury a SHA-256.
 */
export async function exportVerified(config: ExportConfig, deps: CoreDeps & { now: () => Date }): Promise<VerifiedExport> {
  const { bookmark, signedUrl } = await requestExport(config, deps);
  const { body, length } = await openExportDownload(config, deps, signedUrl);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > length) throw new BackupError('size-mismatch');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof BackupError ? error : new BackupError('download-interrupted');
  }
  if (bytes !== length) throw new BackupError('size-mismatch');
  const sql = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    sql.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const { problems, migrations } = inspectSql(sql, config.environment);
  if (problems.length > 0) {
    deps.log(`d1-backup: export check failed (${problems.join(',')})`);
    throw new BackupError('invalid-export');
  }
  return { sql, bytes, sha256: await sha256Hex(sql), bookmark, migrations, exportedAt: deps.now().toISOString() };
}
