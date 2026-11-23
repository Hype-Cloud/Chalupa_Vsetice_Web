// Logika CLI záloh D1 (scripts/backup.ts) nad injektovanými závislostmi – testovatelná.
//
// Příkazy: list, download, verify, decrypt, restore (oba backendy), run / monitor / alert-test.
// - Stažení ověří manifest, velikost a SHA-256; poškozený soubor odmítne. Nic se nepřepisuje bez
//   --force, nic se při stažení nemaže, zápis je atomický (dočasný soubor → přejmenování).
// - Výstup výchozí mimo repozitář (~/d1-backups/<databáze>-<prostředí>); uvnitř repozitáře jen
//   do cesty ignorované Gitem.
// - Obnova jen do NOVÉ databáze (nikdy existující, nikdy zdrojové), po potvrzení názvu cíle;
//   po importu porovná migrace a počty řádků. Dočasné SQL (osobní údaje) se vždy smaže.
// - Do výstupu jen identifikátory, velikosti a kontrolní součty – nikdy tokeny, obsah SQL ani klíče.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseBackupConfig, type BackupBackend, type BackupConfig } from '../../lib/backup/config.ts';
import { BackupError, errorKind, inspectSql, isObject, sha256Hex } from '../../lib/backup/core.ts';
import { downloadSnapshot, GithubClient, listSnapshots, type GithubDeps } from '../../lib/backup/github.ts';
import { runAlertTest, runGithubBackup, runGithubMonitor } from '../../lib/backup/github-run.ts';
import { isAgeFile, openSnapshot, parseIdentityFile } from '../../lib/backup/seal.ts';
import { buildManifest, latestSnapshot, manifestProblems, parseSnapshotId, snapshotBaseName, snapshotId, type SnapshotManifest, type SnapshotRef } from '../../lib/backup/snapshot.ts';

export interface CliDeps extends GithubDeps {
  env: Record<string, string | undefined>;
  /** Výstup pro uživatele (stdout). */
  out: (message: string) => void;
  repoRoot: string;
  home: string;
  tmpdir: string;
  /** Cesta uvnitř repozitáře je ignorovaná Gitem (`git check-ignore`). */
  isIgnored: (path: string) => boolean;
  /** Dotaz v terminálu; null = není interaktivní terminál. */
  prompt: ((question: string) => Promise<string>) | null;
  wrangler: (args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; stdout: string }>;
}

export const USAGE = `Použití: node scripts/backup.ts <příkaz> [volby]
  list      --backend github|r2
  download  --backend github|r2 --snapshot latest|daily/RRRR-MM-DD|monthly/RRRR-MM [--output <adresář>] [--force]
  verify    --file <soubor> [--manifest <manifest.json>] [--identity <klíč.txt>]
  decrypt   --file <soubor> --identity <klíč.txt> [--output <adresář>] [--force]
  restore   --target <nová-db> (--file <soubor> | --backend github|r2 --snapshot …) [--identity <klíč.txt>] [--confirm <nová-db>]
  run | monitor | alert-test  --backend github   (r2: run --backend r2 spustí Cloudflare Workflow)
Konfigurace: proměnné BACKUP_* (README, „Automatické zálohy D1“), volitelně --env-file <soubor>.`;

export function parseArgs(argv: readonly string[]): { command: string; options: Record<string, string | true> } {
  const [command = '', ...rest] = argv;
  const options: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new CliError(`neočekávaný argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq > 0) options[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) options[arg.slice(2)] = rest[++i];
    else options[arg.slice(2)] = true;
  }
  return { command, options };
}

export class CliError extends Error {}

const str = (options: Record<string, string | true>, name: string): string | undefined => {
  const value = options[name];
  if (value === true) throw new CliError(`--${name} vyžaduje hodnotu`);
  return value;
};

function backendOf(options: Record<string, string | true>, env: CliDeps['env']): BackupBackend {
  const value = str(options, 'backend') ?? env.BACKUP_BACKEND?.trim();
  if (value !== 'github' && value !== 'r2') throw new CliError('zadejte --backend github|r2');
  return value;
}

function readConfig(deps: CliDeps, backend: BackupBackend, purpose: 'read' | 'backup' | 'monitor'): BackupConfig {
  // Volba --backend má přednost; BACKUP_BACKEND v prostředí se musí shodovat.
  const { config, errors } = parseBackupConfig({ ...deps.env, BACKUP_BACKEND: deps.env.BACKUP_BACKEND?.trim() || backend }, { backend, purpose });
  if (!config) throw new CliError(`neplatná konfigurace:\n  - ${errors.join('\n  - ')}`);
  return config;
}

// --- Bezpečné soubory ----------------------------------------------------------------------------

/** Výstup mimo repozitář, nebo uvnitř jen do cesty ignorované Gitem. */
/** Canonicalizes existing symlinked path components, including when the leaf is new. */
function realOutputDirectory(dir: string): string {
  let ancestor = resolve(dir);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new CliError('výstupní cestu nelze ověřit');
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    return resolve(realpathSync(ancestor), ...missing);
  } catch {
    throw new CliError('výstupní cestu nelze ověřit');
  }
}

export function assertSafeOutput(dir: string, deps: CliDeps): string {
  // Lexical resolve() alone can be bypassed by a symlink outside the checkout
  // pointing into a tracked directory (including a non-existent child folder).
  const absolute = realOutputDirectory(dir);
  const root = realOutputDirectory(deps.repoRoot);
  const rel = relative(root, absolute);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside && !deps.isIgnored(join(absolute, '.d1-backup-probe'))) {
    throw new CliError('výstup v repozitáři musí být v cestě ignorované Gitem (např. .d1-backups/) – zálohy se nesmí dostat do commitu');
  }
  return absolute;
}

/** Atomický zápis (dočasný soubor 0600 → přejmenování); existující cíl jen s force. */
export function writeAtomic(path: string, bytes: Uint8Array, force: boolean): void {
  if (existsSync(path) && !force) throw new CliError(`soubor už existuje: ${path} (přepsání jen s --force)`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    if (force) {
      // Node's rename replaces an existing file atomically on the same filesystem.
      // Never unlink the original first: a failed rename must preserve it.
      renameSync(temp, path);
    } else {
      // Atomic create-only publication: no race between existsSync and rename
      // can accidentally overwrite a newly created destination.
      linkSync(temp, path);
      rmSync(temp);
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // už zavřený
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

const SNAPSHOT_EXT = /(\.sql\.gz\.age|\.sql\.gz|\.sql)$/;
export const manifestPathFor = (file: string) => join(dirname(file), `${basename(file).replace(SNAPSHOT_EXT, '')}.manifest.json`);

function readManifest(path: string): SnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`manifest nejde načíst: ${path}`);
  }
  const problems = manifestProblems(value, {});
  if (problems.length > 0) throw new CliError(`neplatný manifest (${problems.join(', ')})`);
  return value as SnapshotManifest;
}

function readIdentity(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return parseIdentityFile(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError('soubor s klíčem neobsahuje soukromý klíč age (AGE-SECRET-KEY-1…)');
  }
}

/** Ověří soubor proti manifestu; s klíčem i rozšifrování, SQL a jeho SHA-256. */
export async function verifyFile(bytes: Uint8Array, manifest: SnapshotManifest, fileName: string, identity?: string): Promise<{ sql: Uint8Array | null }> {
  const problems = manifestProblems(manifest, { fileName });
  if (problems.length > 0) throw new CliError(`manifest neodpovídá souboru (${problems.join(', ')})`);
  if (bytes.length !== manifest.file.bytes) throw new CliError('velikost souboru neodpovídá manifestu – soubor je poškozený nebo neúplný');
  if ((await sha256Hex(bytes)) !== manifest.file.sha256) throw new CliError('SHA-256 souboru neodpovídá manifestu – soubor je poškozený');
  if (manifest.file.encryption === 'age' && !isAgeFile(bytes)) throw new CliError('soubor není ve formátu age');
  if (manifest.file.encryption === 'age' && !identity) return { sql: null };
  let sql: Uint8Array;
  try {
    sql = await openSnapshot(bytes, { encryption: manifest.file.encryption, compression: manifest.file.compression, identity });
  } catch (error) {
    throw new CliError(errorKind(error) === 'decryption-failed' ? 'rozšifrování selhalo – nesprávný klíč nebo poškozený soubor' : `soubor nejde otevřít (${errorKind(error)})`);
  }
  if (sql.length !== manifest.sql.bytes || (await sha256Hex(sql)) !== manifest.sql.sha256) throw new CliError('SHA-256 SQL neodpovídá manifestu');
  const check = inspectSql(sql, manifest.environment, manifest.schemaProfile ?? 'chalupa');
  if (check.problems.length > 0) throw new CliError(`SQL neprošlo kontrolou (${check.problems.join(', ')})`);
  if (check.migrations !== manifest.migrations) throw new CliError('počet migrací neodpovídá manifestu');
  return { sql };
}

// --- Zdroje snapshotů (GitHub, R2) ---------------------------------------------------------------

export interface ListedSnapshot extends SnapshotRef {
  bytes: number;
  created: string | null;
  encryption: 'age' | 'none';
}

interface SnapshotSource {
  list(): Promise<ListedSnapshot[]>;
  get(ref: SnapshotRef): Promise<{ fileName: string; bytes: Uint8Array; manifest: SnapshotManifest }>;
}

function githubToken(env: CliDeps['env']): string {
  const token = env.BACKUP_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (!token) throw new CliError('chybí BACKUP_GITHUB_TOKEN (fine-grained token jen pro čtení obsahu zálohovacího repozitáře)');
  return token;
}

function githubSource(config: BackupConfig, deps: CliDeps): SnapshotSource {
  const client = new GithubClient({ owner: config.github!.owner, repo: config.github!.repo, database: config.databaseName, environment: config.environment }, githubToken(deps.env), deps);
  let checked = false;
  const snapshots = async () => {
    if (!checked) await client.assertPrivateRepository('read');
    checked = true;
    return (await listSnapshots(client)).snapshots;
  };
  return {
    async list() {
      return (await snapshots()).map((s) => ({ type: s.type, date: s.date, bytes: s.file.size, created: s.release.published_at, encryption: s.file.name.endsWith('.age') ? 'age' : 'none' }));
    },
    async get(ref) {
      const snapshot = (await snapshots()).find((s) => s.type === ref.type && s.date === ref.date);
      if (!snapshot) throw new CliError(`snapshot ${snapshotId(ref)} neexistuje`);
      const { manifest, bytes } = await downloadSnapshot(client, snapshot);
      return { fileName: snapshot.file.name, bytes, manifest };
    },
  };
}

const CF_API = 'https://api.cloudflare.com/client/v4';
const R2_KEY = /^(daily|monthly)\/(\d{4}-\d{2}(?:-\d{2})?)\.sql$/;

/** R2 přes Cloudflare REST API (token jen Workers R2 Storage Read). Snapshot = SQL bez šifrování. */
function r2Source(config: BackupConfig, deps: CliDeps): SnapshotSource {
  const token = deps.env.BACKUP_R2_API_TOKEN?.trim();
  if (!token) throw new CliError('chybí BACKUP_R2_API_TOKEN (token jen Workers R2 Storage Read)');
  const base = `${CF_API}/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.r2!.bucket)}/objects`;
  const headers = { authorization: `Bearer ${token}` };
  type R2Object = { key: string; size: number; etag: string; last_modified?: string; custom_metadata?: Record<string, string> };
  const objects = async (): Promise<R2Object[]> => {
    const all: R2Object[] = [];
    for (const prefix of ['daily/', 'monthly/']) {
      let cursor = '';
      for (let page = 0; page < 1000; page++) {
        const response = await deps.fetch(`${base}?prefix=${prefix}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers, signal: AbortSignal.timeout(30_000) });
        const body = (await response.json().catch(() => null)) as { success?: boolean; result?: R2Object[]; result_info?: { cursor?: string; is_truncated?: boolean } } | null;
        if (!response.ok || !body?.success || !Array.isArray(body.result)) throw new BackupError(response.status === 401 || response.status === 403 ? 'r2-auth' : 'list-failed');
        all.push(...body.result);
        if (!body.result_info?.is_truncated || !body.result_info.cursor) break;
        cursor = body.result_info.cursor;
      }
    }
    return all;
  };
  const refOf = (key: string): SnapshotRef | null => {
    const match = R2_KEY.exec(key);
    return match ? parseSnapshotId(`${match[1]}/${match[2]}`) : null;
  };
  return {
    async list() {
      return (await objects()).flatMap((o) => {
        const ref = refOf(o.key);
        return ref ? [{ ...ref, bytes: o.size, created: o.last_modified ?? null, encryption: 'none' as const }] : [];
      });
    },
    async get(ref) {
      const object = (await objects()).find((o) => refOf(o.key)?.type === ref.type && refOf(o.key)?.date === ref.date);
      if (!object) throw new CliError(`snapshot ${snapshotId(ref)} neexistuje`);
      const meta = object.custom_metadata ?? {};
      if ((meta.database && meta.database !== config.databaseName) || (meta.environment && meta.environment !== config.environment)) throw new CliError('metadata snapshotu neodpovídají databázi nebo prostředí');
      const response = await deps.fetch(`${base}/${object.key.split('/').map(encodeURIComponent).join('/')}`, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok) throw new BackupError('download-failed');
      const sql = new Uint8Array(await response.arrayBuffer());
      if (sql.length !== object.size) throw new CliError('velikost neodpovídá – stažení je neúplné');
      if (/^[0-9a-f]{32}$/.test(object.etag) && createHash('md5').update(sql).digest('hex') !== object.etag) throw new CliError('MD5 neodpovídá – soubor je poškozený');
      const check = inspectSql(sql, config.environment, config.schemaProfile);
      if (check.problems.length > 0) throw new CliError(`SQL neprošlo kontrolou (${check.problems.join(', ')})`);
      const sha = await sha256Hex(sql);
      const fileName = `${snapshotBaseName(config.databaseName, config.environment, ref)}.sql`;
      const manifest = buildManifest({
        database: config.databaseName,
        environment: config.environment,
        schemaProfile: config.schemaProfile,
        snapshot: ref,
        exportedAt: meta.createdAt ?? object.last_modified ?? '',
        bookmark: meta.bookmark || null,
        migrations: check.migrations,
        sql: { bytes: sql.length, sha256: sha },
        file: { name: fileName, bytes: sql.length, sha256: sha, compression: 'none', encryption: 'none', recipients: [] },
      });
      return { fileName, bytes: sql, manifest };
    },
  };
}

const sourceFor = (backend: BackupBackend, config: BackupConfig, deps: CliDeps) => (backend === 'github' ? githubSource(config, deps) : r2Source(config, deps));

function resolveRef(value: string | undefined, snapshots: readonly ListedSnapshot[]): SnapshotRef {
  if (!value) throw new CliError('zadejte --snapshot latest|daily/RRRR-MM-DD|monthly/RRRR-MM');
  if (value === 'latest') {
    const latest = latestSnapshot(snapshots);
    if (!latest) throw new CliError('žádný snapshot neexistuje');
    return { type: latest.type, date: latest.date };
  }
  const ref = parseSnapshotId(value);
  if (!ref) throw new CliError('neplatný --snapshot (latest, daily/RRRR-MM-DD, monthly/RRRR-MM)');
  return ref;
}

// --- Obnova ----------------------------------------------------------------------------------------

/** Odstraní jen úvodní SQL komentáře; komentáře uvnitř CREATE/TRIGGER zachová. */
function withoutLeadingSqlComments(value: string): string {
  let text = value.trimStart();
  for (;;) {
    if (text.startsWith('--')) {
      const end = text.indexOf('\n');
      if (end < 0) return '';
      text = text.slice(end + 1).trimStart();
    } else if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      if (end < 0) return '';
      text = text.slice(end + 2).trimStart();
    } else {
      return text.trim();
    }
  }
}

/** SQL příkazy exportu D1 – respektuje uvozovky, komentáře a vícepříkazové BEGIN…END triggery.
 * Používá se pouze k počítání INSERTů a očekávaného schématu při obnově/testování.
 * Nejde o obecný SQL parser ani o důkaz úplnosti obsahu vůči zdrojové databázi. */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let state: 'single' | 'double' | 'backtick' | 'bracket' | 'line-comment' | 'block-comment' | null = null;
  let word = '';
  let trigger = false;
  let triggerBody = false;
  let caseDepth = 0;
  // Úvodní tokeny příkazu: trigger je jen `CREATE [TEMP|TEMPORARY] TRIGGER …`, nikoli výskyt
  // slova TRIGGER/BEGIN/END kdekoli v příkazu (např. sloupce `trigger`, `begin`, `end`).
  let leading: string[] = [];
  const flushWord = () => {
    if (!word) return;
    const token = word.toUpperCase();
    if (leading.length < 3) {
      leading.push(token);
      if (leading[0] === 'CREATE' && (leading[1] === 'TRIGGER' || ((leading[1] === 'TEMP' || leading[1] === 'TEMPORARY') && leading[2] === 'TRIGGER'))) trigger = true;
    }
    if (trigger) {
      if (token === 'BEGIN') triggerBody = true;
      else if (triggerBody && token === 'CASE') caseDepth++;
      else if (triggerBody && token === 'END') {
        if (caseDepth > 0) caseDepth--;
        else triggerBody = false;
      }
    }
    word = '';
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'line-comment') {
      if (ch === '\n') state = null;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = null; i++; }
      continue;
    }
    if (state) {
      const closing = state === 'single' ? "'" : state === 'double' ? '"' : state === 'backtick' ? '`' : ']';
      if (ch === closing) {
        // SQLite escaped quote: '' or "" (also doubled backticks/closing brackets).
        if (next === closing) i++;
        else state = null;
      }
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) { word += ch; continue; }
    flushWord();
    if (ch === '-' && next === '-') { state = 'line-comment'; i++; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; i++; continue; }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '`') { state = 'backtick'; continue; }
    if (ch === '[') { state = 'bracket'; continue; }
    if (ch === ';' && !triggerBody) {
      const statement = withoutLeadingSqlComments(sql.slice(start, i + 1));
      if (statement) out.push(statement);
      start = i + 1;
      trigger = false;
      triggerBody = false;
      caseDepth = 0;
      leading = [];
    }
  }
  flushWord();
  const rest = withoutLeadingSqlComments(sql.slice(start));
  if (rest) out.push(rest);
  return out;
}

const SCHEMA_STATEMENT = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|([A-Za-z_][\w]*))/i;

/**
 * Objekty schématu exportu odvozené z rozdělených SQL příkazů (`sqlStatements`): rozhoduje jen
 * začátek příkazu, takže obsah textových hodnot (včetně U+2028/U+2029 či „CREATE …“ v řetězci)
 * seznam objektů neovlivní. Interní objekty `sqlite_*` se neověřují.
 */
function schemaObjects(sql: string): { name: string; type: string; definition: string }[] {
  const objects: { name: string; type: string; definition: string }[] = [];
  for (const statement of sqlStatements(sql)) {
    const match = SCHEMA_STATEMENT.exec(statement);
    if (!match) continue;
    const name = match[2] !== undefined ? match[2].replace(/""/g, '"') : match[3];
    if (!name.startsWith('sqlite_')) objects.push({ name, type: match[1].toLowerCase(), definition: normalizedSchemaSql(statement) });
  }
  return objects;
}

/** SQL exportem definované uživatelské objekty (název → typ). */
export function expectedSchema(sql: string): Map<string, string> {
  return new Map(schemaObjects(sql).map((o) => [o.name, o.type]));
}

/** SQLite ukládá CREATE bez koncového středníku a IF NOT EXISTS.
 * Ostatní text (včetně CHECK, triggerů a WHERE u indexů) porovnáváme. */
export function normalizedSchemaSql(sql: string): string {
  return sql.trim()
    .replace(/;\s*$/, '')
    .replace(/^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+)IF\s+NOT\s+EXISTS\s+/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Úplné definice CREATE z ověřeného D1 exportu, nikoli jen názvy objektů (stejný zdroj jako expectedSchema). */
export function expectedSchemaDefinitions(sql: string): Map<string, string> {
  return new Map(schemaObjects(sql).map((o) => [o.name, o.definition]));
}

/** Očekávané počty řádků podle INSERT příkazů exportu (bez interních tabulek SQLite). */
export function expectedRowCounts(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const statement of sqlStatements(sql)) {
    const match = /^INSERT INTO "([^"]+)"/.exec(statement);
    if (match && !match[1].startsWith('sqlite_')) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

function wranglerJson(stdout: string): unknown {
  const start = stdout.search(/^\s*[[{]/m);
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new CliError('neočekávaný výstup wrangleru');
  }
}

async function restore(options: Record<string, string | true>, deps: CliDeps): Promise<void> {
  const target = str(options, 'target');
  if (!target || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target) || target.length > 64) throw new CliError('zadejte --target <název nové D1> (malá písmena, číslice, pomlčky)');
  const identity = readIdentity(str(options, 'identity'));
  const work = mkdtempSync(join(deps.tmpdir, 'd1-restore-'));
  try {
    // 1) Zdroj: lokální soubor + manifest, nebo stažení z backendu (vždy ověřené).
    let bytes: Uint8Array;
    let manifest: SnapshotManifest;
    let fileName: string;
    const file = str(options, 'file');
    if (file) {
      bytes = new Uint8Array(readFileSync(file));
      manifest = readManifest(str(options, 'manifest') ?? manifestPathFor(file));
      fileName = basename(file);
    } else {
      const backend = backendOf(options, deps.env);
      const source = sourceFor(backend, readConfig(deps, backend, 'read'), deps);
      ({ bytes, manifest, fileName } = await source.get(resolveRef(str(options, 'snapshot'), await source.list())));
    }
    if (manifest.file.encryption === 'age' && !identity) throw new CliError('šifrovaný snapshot – zadejte --identity <soubor s klíčem>');
    // 2) Integrita, rozšifrování, prostředí a struktura SQL.
    const { sql } = await verifyFile(bytes, manifest, fileName, identity);
    if (!sql) throw new CliError('SQL nejde ověřit');
    if (target === manifest.database) throw new CliError('cíl obnovy nesmí být zdrojová databáze – obnova jen do nové D1');

    const accountId = (deps.env.BACKUP_CLOUDFLARE_ACCOUNT_ID ?? deps.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
    if (!/^[0-9a-f]{32}$/.test(accountId)) throw new CliError('chybí BACKUP_CLOUDFLARE_ACCOUNT_ID');
    const wenv = { CLOUDFLARE_ACCOUNT_ID: accountId };
    // Wrangler běží v prázdném dočasném adresáři: žádná konfigurace projektu se nezmění.
    const run = (args: string[]) => deps.wrangler(args, { cwd: work, env: wenv });

    // 3) Cíl nesmí existovat (chrání produkci i jakoukoli jinou existující D1).
    const listed = await run(['d1', 'list', '--json']);
    if (listed.code !== 0) throw new CliError('výpis D1 selhal – obnova zastavena');
    const existing = wranglerJson(listed.stdout);
    if (!Array.isArray(existing)) throw new CliError('neočekávaný výpis D1');
    if (existing.some((db) => isObject(db) && db.name === target)) throw new CliError(`D1 „${target}“ už existuje – obnova jen do nové databáze`);

    // 4) Potvrzení vzdálené operace.
    deps.out(`Obnova snapshotu ${manifest.snapshot.id} (${manifest.database}, ${manifest.environment}, migrace ${manifest.migrations}) do NOVÉ D1 „${target}“.`);
    const confirmed = str(options, 'confirm') ?? (deps.prompt ? (await deps.prompt(`Pro pokračování napište název nové databáze (${target}): `)).trim() : undefined);
    if (confirmed !== target) throw new CliError('obnova nepotvrzena – nic se nezměnilo');

    // 5) Vytvoření a import (SQL jen v dočasném adresáři 0700, po použití smazáno).
    const sqlPath = join(work, 'restore.sql');
    writeAtomic(sqlPath, sql, false);
    const created = await run(['d1', 'create', target, '--update-config=false']);
    if (created.code !== 0) throw new CliError('vytvoření D1 selhalo');
    const imported = await run(['d1', 'execute', target, '--remote', '--yes', `--file=${sqlPath}`]);
    rmSync(sqlPath, { force: true });
    if (imported.code !== 0) throw new CliError(`import selhal – nová D1 „${target}“ může být neúplná; smažte ji (wrangler d1 delete ${target})`);

    // 6) Kontrola: migrace a počty řádků.
    const originalSql = new TextDecoder().decode(sql);
    const counts = expectedRowCounts(originalSql);
    const expectedObjects = expectedSchema(originalSql);
    const expectedDefinitions = expectedSchemaDefinitions(originalSql);
    if (expectedDefinitions.size !== expectedObjects.size ||
        [...expectedObjects].some(([name]) => !expectedDefinitions.has(name))) {
      throw new CliError('export obsahuje neočekávanou definici schématu');
    }
    const tables = [...expectedObjects.entries()].filter(([, type]) => type === 'table').map(([name]) => name);
    if (manifest.schemaProfile !== 'generic' && !tables.includes('d1_migrations')) throw new CliError('export neobsahuje d1_migrations');
    // Ověřit i prázdné tabulky, které nemají žádné INSERT INTO.
    for (const table of tables) if (!counts.has(table)) counts.set(table, 0);
    // D1 má omezený počet částí složeného SELECTu; jeden COUNT(*) na tabulku
    // je spolehlivější než UNION ALL všech tabulek (včetně prázdných).
    const actual = new Map<string, number>();
    for (const table of tables) {
      const quoted = table.replace(/"/g, '""');
      const checked = await run(['d1', 'execute', target, '--remote', '--json', `--command=SELECT COUNT(*) AS n FROM "${quoted}"`]);
      if (checked.code !== 0) throw new CliError(`kontrola tabulky ${table} selhala`);
      const response = wranglerJson(checked.stdout);
      if (!Array.isArray(response) || !isObject(response[0]) || !Array.isArray(response[0].results) ||
          !isObject(response[0].results[0]) || !Number.isSafeInteger(Number(response[0].results[0].n))) {
        throw new CliError(`neplatná odpověď při kontrole tabulky ${table}`);
      }
      actual.set(table, Number(response[0].results[0].n));
    }
    const mismatch = tables.filter((t) => (t === 'd1_migrations' ? manifest.migrations : (counts.get(t) ?? 0)) !== actual.get(t));
    if (mismatch.length > 0) throw new CliError(`obnovená D1 neodpovídá záloze (tabulky: ${mismatch.join(', ')})`);
    const schemaResult = await run(['d1', 'execute', target, '--remote', '--json',
      '--command=SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE \'sqlite_%\'']);
    if (schemaResult.code !== 0) throw new CliError('kontrola schématu obnovené D1 selhala');
    const schemaResponse = wranglerJson(schemaResult.stdout);
    if (!Array.isArray(schemaResponse) || !isObject(schemaResponse[0]) || !Array.isArray(schemaResponse[0].results)) {
      throw new CliError('neplatná odpověď na kontrolu schématu');
    }
    const rowsOfSchema = schemaResponse[0].results as unknown[];
    if (rowsOfSchema.some((value) => !isObject(value) || typeof value.name !== 'string' ||
        typeof value.type !== 'string' || typeof value.sql !== 'string')) {
      throw new CliError('neplatná SQL definice schématu');
    }
    const restored = new Map((rowsOfSchema as { type: string; name: string; sql: string }[])
      .map((r) => [r.name, { type: r.type, sql: normalizedSchemaSql(r.sql) }]));
    const missing = [...expectedObjects].filter(([name, type]) => restored.get(name)?.type !== type).map(([name]) => name);
    if (missing.length > 0) throw new CliError(`obnovená D1 postrádá objekty schématu: ${missing.join(', ')}`);
    const changed = [...expectedDefinitions].filter(([name, sql]) => restored.get(name)?.sql !== sql).map(([name]) => name);
    if (changed.length > 0) throw new CliError(`obnovená D1 má změněné definice schématu: ${changed.join(', ')}`);
    // Miniflare/Cloudflare D1 si vytváří vlastní interní metadata tabulku,
    // která v exportu aplikace není. Ignorujeme pouze přesný systémový název.
    const extra = [...restored.keys()].filter((name) => name !== '_cf_METADATA' && !expectedDefinitions.has(name));
    if (extra.length > 0) throw new CliError(`obnovená D1 má neočekávané objekty schématu: ${extra.join(', ')}`);
    deps.out(`Obnova ověřena: ${manifest.migrations} migrací, ${tables.length} tabulek (včetně prázdných), ${expectedObjects.size} objektů schématu.`);
    deps.out(`Nová D1 „${target}“ je samostatná. Po ověření ji smažte (wrangler d1 delete ${target}), pokud ji nepotřebujete.`);
  } finally {
    // Dočasná data (osobní údaje) vždy pryč.
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Příkazy ---------------------------------------------------------------------------------------

const formatBytes = (n: number) => (n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`);

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let command: string;
  let options: Record<string, string | true>;
  try {
    ({ command, options } = parseArgs(argv));
  } catch (error) {
    deps.out(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case 'list': {
        const backend = backendOf(options, deps.env);
        const config = readConfig(deps, backend, 'read');
        const snapshots = await sourceFor(backend, config, deps).list();
        snapshots.sort((a, b) => a.type.localeCompare(b.type) || b.date.localeCompare(a.date));
        deps.out(`${config.databaseName} (${config.environment}) – ${backend}: ${snapshots.length} snapshotů`);
        for (const s of snapshots) deps.out(`  ${snapshotId(s).padEnd(19)} ${formatBytes(s.bytes).padStart(11)}  ${s.encryption === 'age' ? 'šifrováno' : 'bez šifrování'}  ${s.created ?? ''}`);
        const latest = latestSnapshot(snapshots);
        deps.out(`Nejnovější: ${latest ? snapshotId(latest) : 'žádný'}`);
        return 0;
      }
      case 'download': {
        const backend = backendOf(options, deps.env);
        const config = readConfig(deps, backend, 'read');
        const source = sourceFor(backend, config, deps);
        const ref = resolveRef(str(options, 'snapshot'), await source.list());
        const dir = assertSafeOutput(str(options, 'output') ?? join(deps.home, 'd1-backups', `${config.databaseName}-${config.environment}`), deps);
        const { fileName, bytes, manifest } = await source.get(ref);
        await verifyFile(bytes, manifest, fileName);
        const force = options.force === true;
        const filePath = join(dir, fileName);
        const manifestPath = manifestPathFor(filePath);
        if (!force && (existsSync(filePath) || existsSync(manifestPath))) throw new CliError(`soubor už existuje v ${dir} (přepsání jen s --force)`);
        writeAtomic(filePath, bytes, force);
        writeAtomic(manifestPath, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), force);
        deps.out(`Staženo a ověřeno: ${filePath}`);
        deps.out(`  ${formatBytes(bytes.length)}, SHA-256 ${manifest.file.sha256}, ${manifest.file.encryption === 'age' ? 'šifrováno (age)' : 'bez šifrování'}`);
        return 0;
      }
      case 'verify': {
        const file = str(options, 'file');
        if (!file) throw new CliError('zadejte --file <soubor>');
        const manifest = readManifest(str(options, 'manifest') ?? manifestPathFor(file));
        const { sql } = await verifyFile(new Uint8Array(readFileSync(file)), manifest, basename(file), readIdentity(str(options, 'identity')));
        deps.out(`OK: ${basename(file)} odpovídá manifestu (${manifest.database}, ${manifest.environment}, ${manifest.snapshot.id}, SHA-256 ${manifest.file.sha256}).`);
        deps.out(sql ? `  Rozšifrováno a SQL ověřeno (${manifest.migrations} migrací).` : '  Obsah šifrovaného SQL ověří až --identity (decrypt / restore).');
        return 0;
      }
      case 'decrypt': {
        const file = str(options, 'file');
        if (!file) throw new CliError('zadejte --file <soubor>');
        const identity = readIdentity(str(options, 'identity'));
        const manifest = readManifest(str(options, 'manifest') ?? manifestPathFor(file));
        if (manifest.file.encryption === 'age' && !identity) throw new CliError('zadejte --identity <soubor s klíčem>');
        const { sql } = await verifyFile(new Uint8Array(readFileSync(file)), manifest, basename(file), identity);
        const dir = assertSafeOutput(str(options, 'output') ?? dirname(resolve(file)), deps);
        const output = join(dir, `${basename(file).replace(SNAPSHOT_EXT, '')}.sql`);
        if (resolve(output) === resolve(file)) throw new CliError('výstup by přepsal vstupní soubor');
        writeAtomic(output, sql!, options.force === true);
        deps.out(`Rozšifrováno a ověřeno: ${output} (obsahuje osobní údaje – po použití smažte).`);
        return 0;
      }
      case 'restore':
        await restore(options, deps);
        return 0;
      case 'run':
      case 'monitor':
      case 'alert-test': {
        const backend = backendOf(options, deps.env);
        if (backend === 'r2') {
          const workflow = deps.env.BACKUP_R2_WORKFLOW?.trim();
          if (!workflow || !/^[a-z0-9-]+$/.test(workflow)) throw new CliError('chybí BACKUP_R2_WORKFLOW (název Cloudflare Workflow zálohy)');
          const mode = command === 'run' ? 'backup' : command;
          const result = await deps.wrangler(['workflows', 'trigger', workflow, JSON.stringify({ mode })], { cwd: deps.repoRoot, env: {} });
          if (result.code !== 0) throw new CliError('spuštění Workflow selhalo');
          deps.out(`Workflow ${workflow} spuštěn (${mode}); výsledek v dashboardu nebo „wrangler workflows instances list ${workflow}“.`);
          return 0;
        }
        const env = { ...deps.env, BACKUP_BACKEND: deps.env.BACKUP_BACKEND?.trim() || 'github' };
        const result =
          command === 'run'
            ? await runGithubBackup(env, deps)
            : command === 'monitor'
              ? await runGithubMonitor(env, deps)
              : await runAlertTest(env, deps, `${deps.now().toISOString()}-${randomBytes(4).toString('hex')}`);
        deps.out(
          JSON.stringify({ mode: result.mode, date: result.date, daily: result.daily, monthly: result.monthly, bytes: result.bytes, pruned: result.pruned, latest: result.status?.latest ?? null, stale: result.status?.stale, alerts: result.alerts }),
        );
        return 0;
      }
      default:
        deps.out(USAGE);
        return command === '' || command === 'help' || options.help ? 0 : 2;
    }
  } catch (error) {
    if (error instanceof CliError) deps.out(`Chyba: ${error.message}`);
    else deps.out(`Chyba: ${errorKind(error)}`);
    return 1;
  }
}
