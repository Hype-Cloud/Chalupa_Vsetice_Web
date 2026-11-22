// Snapshoty, manifest a retence – společné pro všechny backendy (čisté funkce).
//
// - Snapshot: `daily/YYYY-MM-DD` (záloha dne) nebo `monthly/YYYY-MM` (první úspěšná záloha
//   měsíce; stejný ověřený soubor jako denní, bez nového exportu).
// - Manifest (JSON vedle souboru): identita databáze a prostředí, typ a datum snapshotu, čas
//   exportu, bookmark, počet migrací, velikosti a SHA-256 SQL i uloženého souboru, komprese
//   a šifrování. Žádná credentials ani osobní údaje.
// - Retence: ponechá `keepDaily` nejnovějších denních a `keepMonthly` nejnovějších měsíčních;
//   rozhoduje jen nad jednoznačně rozpoznanými snapshoty dané databáze a prostředí.

import { isObject } from './core.ts';

export type SnapshotType = 'daily' | 'monthly';
export const MANIFEST_FORMAT = 'd1-backup';
export const MANIFEST_VERSION = 1;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface SnapshotRef {
  type: SnapshotType;
  /** YYYY-MM-DD (daily) nebo YYYY-MM (monthly). */
  date: string;
}

export const snapshotId = (ref: SnapshotRef) => `${ref.type}/${ref.date}`;
export const monthOf = (date: string) => date.slice(0, 7);

/** `daily/YYYY-MM-DD`, `monthly/YYYY-MM`; jinak null. (`latest` řeší volající.) */
export function parseSnapshotId(value: string): SnapshotRef | null {
  const match = /^(daily|monthly)\/(.+)$/.exec(value.trim());
  if (!match) return null;
  const [, type, date] = match;
  if (type === 'daily' && DATE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)) return { type, date };
  if (type === 'monthly' && MONTH.test(date)) return { type, date };
  return null;
}

/** Základ názvu souboru: `<databáze>-<prostředí>-<typ>-<datum>` (bez přípony). */
export const snapshotBaseName = (database: string, environment: string, ref: SnapshotRef) => `${database}-${environment}-${ref.type}-${ref.date}`;

export interface SnapshotManifest {
  format: typeof MANIFEST_FORMAT;
  version: typeof MANIFEST_VERSION;
  database: string;
  environment: string;
  /** Absent on old snapshots, which were always Chalupa-specific. */
  schemaProfile?: 'chalupa' | 'generic';
  snapshot: { type: SnapshotType; date: string; id: string };
  exportedAt: string;
  bookmark: string | null;
  migrations: number;
  sql: { bytes: number; sha256: string };
  file: { name: string; bytes: number; sha256: string; compression: 'gzip' | 'none'; encryption: 'age' | 'none'; recipients: string[] };
}

export function buildManifest(input: Omit<SnapshotManifest, 'format' | 'version' | 'snapshot'> & { snapshot: SnapshotRef }): SnapshotManifest {
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    database: input.database,
    environment: input.environment,
    ...(input.schemaProfile === undefined ? {} : { schemaProfile: input.schemaProfile }),
    snapshot: { type: input.snapshot.type, date: input.snapshot.date, id: snapshotId(input.snapshot) },
    exportedAt: input.exportedAt,
    bookmark: input.bookmark,
    migrations: input.migrations,
    sql: input.sql,
    file: input.file,
  };
}

/** Kopie manifestu pro jiný snapshot téhož souboru (měsíční z denního) – obsah souboru stejný, jiný název. */
export const manifestFor = (manifest: SnapshotManifest, ref: SnapshotRef, fileName: string): SnapshotManifest => ({
  ...manifest,
  snapshot: { type: ref.type, date: ref.date, id: snapshotId(ref) },
  file: { ...manifest.file, name: fileName },
});

/** Ověření tvaru manifestu a shody s očekávanou identitou; vrací problémy (prázdné = v pořádku). */
export function manifestProblems(value: unknown, expected: { database?: string; environment?: string; snapshot?: SnapshotRef; fileName?: string }): string[] {
  if (!isObject(value)) return ['manifest-invalid'];
  const m = value as Partial<SnapshotManifest>;
  const problems: string[] = [];
  if (m.format !== MANIFEST_FORMAT || m.version !== MANIFEST_VERSION) problems.push('manifest-format');
  if (typeof m.database !== 'string' || typeof m.environment !== 'string') problems.push('manifest-identity');
  if (m.schemaProfile !== undefined && m.schemaProfile !== 'chalupa' && m.schemaProfile !== 'generic') problems.push('manifest-schema-profile');
  if (!isObject(m.snapshot) || (m.snapshot.type !== 'daily' && m.snapshot.type !== 'monthly') || !parseSnapshotId(`${m.snapshot.type}/${m.snapshot.date}`)) problems.push('manifest-snapshot');
  if (!isObject(m.sql) || !Number.isSafeInteger(m.sql.bytes) || m.sql.bytes <= 0 || !SHA256.test(String(m.sql.sha256))) problems.push('manifest-sql');
  if (
    !isObject(m.file) ||
    typeof m.file.name !== 'string' ||
    !Number.isSafeInteger(m.file.bytes) ||
    m.file.bytes <= 0 ||
    !SHA256.test(String(m.file.sha256)) ||
    (m.file.compression !== 'gzip' && m.file.compression !== 'none') ||
    (m.file.encryption !== 'age' && m.file.encryption !== 'none') ||
    !Array.isArray(m.file.recipients)
  ) {
    problems.push('manifest-file');
  }
  if (!Number.isSafeInteger(m.migrations) || (m.migrations ?? -1) < 0 || (m.schemaProfile !== 'generic' && m.migrations === 0)) problems.push('manifest-migrations');
  if (problems.length > 0) return problems;
  if (expected.database !== undefined && m.database !== expected.database) problems.push('manifest-database-mismatch');
  if (expected.environment !== undefined && m.environment !== expected.environment) problems.push('manifest-environment-mismatch');
  if (expected.snapshot && (m.snapshot!.type !== expected.snapshot.type || m.snapshot!.date !== expected.snapshot.date)) problems.push('manifest-snapshot-mismatch');
  if (expected.fileName !== undefined && m.file!.name !== expected.fileName) problems.push('manifest-file-mismatch');
  return problems;
}

export interface RetentionCandidate extends SnapshotRef {
  /** Identifikátor v úložišti (release id, klíč objektu). */
  id: string | number;
}

/**
 * Snapshoty ke smazání: nad `keepDaily` nejnovějších denních a `keepMonthly` nejnovějších
 * měsíčních. Duplicitní data (nemělo by nastat) se nikdy nemažou naslepo – vrací se jen
 * jednoznačně starší položky.
 */
export function selectForRetention<T extends RetentionCandidate>(snapshots: readonly T[], keepDaily: number, keepMonthly: number): T[] {
  const pick = (type: SnapshotType, keep: number) => {
    const list = snapshots.filter((s) => s.type === type).sort((a, b) => b.date.localeCompare(a.date));
    const kept = new Set(list.slice(0, keep).map((s) => s.date));
    return list.slice(keep).filter((s) => !kept.has(s.date));
  };
  return [...pick('daily', keepDaily), ...pick('monthly', keepMonthly)];
}

/** Nejnovější snapshot (denní mají přednost v rámci stejného data – jsou novější). */
export function latestSnapshot<T extends SnapshotRef>(snapshots: readonly T[]): T | null {
  const daily = snapshots.filter((s) => s.type === 'daily').sort((a, b) => b.date.localeCompare(a.date));
  if (daily.length > 0) return daily[0];
  return snapshots.filter((s) => s.type === 'monthly').sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}
