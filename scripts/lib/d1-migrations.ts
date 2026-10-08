// Kontrola a řízená aplikace D1 migrací (produkce a testovací D1 pro Worker Previews).
//
// - check: jen čte (SELECT z d1_migrations a meta). Zastaví deploy, pokud cílové D1 chybí
//   migrace z repozitáře, DB patří jinému prostředí, konfigurace je nekonzistentní nebo D1 nejde
//   přečíst (fail-closed). Migrace navíc v DB (rollback, jiná větev) jsou jen varování.
// - apply: jen ručně z terminálu (ne v CI). Produkce vyžaduje opsání názvu DB; destruktivní
//   migrace v produkci navíc zálohu (Time Travel bookmark + export) a potvrzovací frázi.
//
// Wrangler se volá přes injektovaný runner (testy), nikdy přes shell.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TargetName = 'production' | 'preview';

export interface Target {
  name: TargetName;
  /** Název D1 databáze (wrangler d1 … <database>). */
  database: string;
  /** Konfigurace, ze které wrangler d1 vezme database_id (top-level d1_databases). */
  config: string;
  /** Očekávaná hodnota meta.environment v databázi. */
  environment: string;
}

export const TARGETS: Record<TargetName, Target> = {
  production: { name: 'production', database: 'chalupa-vsetice-rezervace', config: 'wrangler.jsonc', environment: 'production' },
  preview: { name: 'preview', database: 'chalupa-vsetice-rezervace-test', config: 'wrangler.preview-migrations.jsonc', environment: 'preview' },
};

export const MIGRATIONS_DIR = 'migrations';
export const BACKUP_DIR = '.d1-backups';
/** Fráze, kterou je nutné opsat před destruktivní migrací produkce. */
export const DESTRUCTIVE_CONFIRMATION = 'ZALOHA OVERENA';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Seřazené názvy migrací; ověří formát NNNN_nazev.sql a souvislé číslování od 0001. */
export function listLocalMigrations(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const errors: string[] = [];
  files.forEach((file, index) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) errors.push(`neplatný název migrace: ${file} (očekává se NNNN_nazev.sql)`);
    else if (Number(match[1]) !== index + 1) errors.push(`migrace ${file} nenavazuje (očekávané číslo ${String(index + 1).padStart(4, '0')})`);
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return files;
}

/** JSONC (komentáře // a /* *\/, koncové čárky) → objekt. Řetězce zůstávají beze změny. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) throw new Error('neukončený komentář v JSONC');
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface D1Binding {
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
}
interface WranglerConfig {
  vars?: Record<string, unknown>;
  d1_databases?: D1Binding[];
  previews?: { vars?: Record<string, unknown>; d1_databases?: D1Binding[] };
  main?: string;
}

/**
 * Konzistence konfigurací: produkce a Preview mají každá svou D1 (různá ID), konfigurace pro
 * migrace testovací D1 ukazuje na stejnou DB jako previews ve wrangler.jsonc, produkce nemá
 * zapnutý rezervační POST a prostředí jsou správně označená.
 */
export function verifyConfigs(wranglerText: string, previewMigrationsText: string): string[] {
  const errors: string[] = [];
  const main = parseJsonc(wranglerText) as WranglerConfig;
  const previewCfg = parseJsonc(previewMigrationsText) as WranglerConfig;
  const db = (list: D1Binding[] | undefined) => list?.find((d) => d.binding === 'DB');
  const prod = db(main.d1_databases);
  const preview = db(main.previews?.d1_databases);
  const previewMigrations = db(previewCfg.d1_databases);

  if (!prod || prod.database_name !== TARGETS.production.database) errors.push(`wrangler.jsonc: produkční D1 musí být ${TARGETS.production.database}`);
  if (!preview || preview.database_name !== TARGETS.preview.database) errors.push(`wrangler.jsonc: previews D1 musí být ${TARGETS.preview.database}`);
  if (!previewMigrations || previewMigrations.database_name !== TARGETS.preview.database) {
    errors.push(`${TARGETS.preview.config}: D1 musí být ${TARGETS.preview.database}`);
  }
  if (prod?.database_id && prod.database_id === preview?.database_id) errors.push('produkce a Preview sdílejí stejnou D1 – musí být oddělené');
  if (preview?.database_id !== previewMigrations?.database_id) errors.push(`${TARGETS.preview.config}: database_id se liší od previews.d1_databases ve wrangler.jsonc`);
  for (const d of [prod, preview, previewMigrations]) {
    if (d && d.migrations_dir !== MIGRATIONS_DIR) errors.push(`${d.database_name}: migrations_dir musí být "${MIGRATIONS_DIR}"`);
  }
  if (previewCfg.main) errors.push(`${TARGETS.preview.config} slouží jen pro wrangler d1 – nesmí mít "main" (nepoužívat pro deploy)`);
  if (main.vars?.BOOKING_ENV !== 'production') errors.push('wrangler.jsonc: vars.BOOKING_ENV musí být "production"');
  if (main.previews?.vars?.BOOKING_ENV !== 'preview') errors.push('wrangler.jsonc: previews.vars.BOOKING_ENV musí být "preview"');
  if (main.vars && 'BOOKING_API_ENABLED' in main.vars) errors.push('wrangler.jsonc: produkční rezervační POST musí zůstat vypnutý (žádné vars.BOOKING_API_ENABLED)');
  return errors;
}

/** Stav cílové D1 z `wrangler d1 execute --json` (dva SELECTy). */
export interface RemoteState {
  applied: string[];
  environment: string | null;
}

export const STATE_QUERY = `SELECT name FROM d1_migrations ORDER BY id; SELECT value FROM meta WHERE key = 'environment'`;

export function parseRemoteState(stdout: string): RemoteState {
  // JSON začíná na prvním řádku s „[“ nebo „{“ (před ním mohou být hlášky wrangleru).
  const lines = stdout.split('\n');
  const first = lines.findIndex((line) => /^[[{]/.test(line.trim()));
  if (first === -1 || lines[first].trim().startsWith('{')) throw new Error('D1 vrátila chybu nebo nečitelnou odpověď');
  let data: unknown;
  try {
    data = JSON.parse(lines.slice(first).join('\n'));
  } catch {
    throw new Error('nečitelná odpověď wrangler d1 execute');
  }
  if (!Array.isArray(data) || data.length !== 2 || !data.every((r) => r && r.success === true && Array.isArray(r.results))) {
    throw new Error('neočekávaný tvar odpovědi wrangler d1 execute');
  }
  const applied = (data[0].results as { name?: unknown }[]).map((r) => r.name);
  if (!applied.every((n): n is string => typeof n === 'string')) throw new Error('neočekávaný obsah d1_migrations');
  const env = (data[1].results as { value?: unknown }[])[0]?.value;
  return { applied, environment: typeof env === 'string' ? env : null };
}

export interface MigrationDiff {
  /** V repozitáři, ale ne v D1 – deploy by běžel nad starým schématem. */
  pending: string[];
  /** V D1, ale ne v repozitáři (rollback nebo jiná větev). */
  unknown: string[];
}

export function diffMigrations(local: readonly string[], applied: readonly string[]): MigrationDiff {
  const appliedSet = new Set(applied);
  const localSet = new Set(local);
  return { pending: local.filter((m) => !appliedSet.has(m)), unknown: applied.filter((m) => !localSet.has(m)) };
}

/** SQL bez komentářů a obsahu řetězců ('…' → ''), aby klíčová slova v textu nic neovlivnila. */
function stripSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ');
}

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b/i, 'DROP'],
  [/\bALTER\s+TABLE\b[^;]*\bDROP\b/i, 'ALTER TABLE … DROP COLUMN'],
  [/\bALTER\s+TABLE\b[^;]*\bRENAME\b/i, 'ALTER TABLE … RENAME'],
  [/\bDELETE\s+FROM\b/i, 'DELETE'],
  [/\bUPDATE\s+\w+\s+SET\b/i, 'UPDATE'],
  [/\b(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i, 'REPLACE'],
];

/**
 * Důvody, proč je migrace destruktivní (mění nebo maže existující data či schéma), jinak [].
 * Těla CREATE TRIGGER se ignorují – běží až při pozdějších zápisech, ne při migraci.
 * Konzervativní: v pochybnostech označí migraci jako destruktivní.
 */
export function destructiveReasons(sql: string): string[] {
  const code = stripSql(sql).replace(/\bCREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi, ' ');
  return DESTRUCTIVE.filter(([pattern]) => pattern.test(code)).map(([, reason]) => reason);
}

export function readMigration(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}
