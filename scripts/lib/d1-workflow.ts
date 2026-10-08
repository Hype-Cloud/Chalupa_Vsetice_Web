// Průběh `check` a `apply` nad injektovanými závislostmi (wrangler, terminál, soubory).

import { join } from 'node:path';
import {
  BACKUP_DIR,
  DESTRUCTIVE_CONFIRMATION,
  destructiveReasons,
  diffMigrations,
  listLocalMigrations,
  MIGRATIONS_DIR,
  parseRemoteState,
  readMigration,
  STATE_QUERY,
  TARGETS,
  type Target,
  verifyConfigs,
} from './d1-migrations.ts';
import { readFileSync } from 'node:fs';

export interface WranglerResult {
  code: number;
  stdout: string;
}

export interface WorkflowDeps {
  /** Kořen repozitáře. */
  root: string;
  /**
   * Spustí wrangler s argumenty (bez shellu). `interactive` = předat terminál (stdin/stdout),
   * jinak zachytit stdout.
   */
  wrangler: (args: string[], options: { interactive: boolean }) => Promise<WranglerResult>;
  /** Interaktivní terminál mimo CI. Bez něj se migrace neaplikují. */
  interactive: boolean;
  prompt: (question: string) => Promise<string>;
  /** Velikost souboru v bajtech, nebo null, když neexistuje. */
  fileSize: (path: string) => number | null;
  mkdir: (path: string) => void;
  now: () => Date;
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface CheckResult {
  ok: boolean;
  pending: string[];
  /** Čekající migrace → důvody destruktivity (jen destruktivní). */
  destructive: Map<string, string[]>;
}

const remote = (target: Target) => ['--remote', '--config', target.config];

/** Jen čtení: porovná migrace v repozitáři se stavem cílové D1. Chyba = ok: false (fail-closed). */
export async function checkTarget(target: Target, deps: WorkflowDeps): Promise<CheckResult> {
  const fail = (message: string): CheckResult => {
    deps.error(`✗ ${message}`);
    return { ok: false, pending: [], destructive: new Map() };
  };
  const dir = join(deps.root, MIGRATIONS_DIR);
  let local: string[];
  try {
    local = listLocalMigrations(dir);
    const configErrors = verifyConfigs(readFileSync(join(deps.root, 'wrangler.jsonc'), 'utf8'), readFileSync(join(deps.root, TARGETS.preview.config), 'utf8'));
    if (configErrors.length > 0) return fail(`konfigurace:\n  ${configErrors.join('\n  ')}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  deps.log(`Kontrola D1 ${target.database} (${target.name}): ${local.length} migrací v repozitáři`);
  let result: WranglerResult;
  try {
    result = await deps.wrangler(['d1', 'execute', target.database, ...remote(target), '--json', '--command', STATE_QUERY], { interactive: false });
  } catch {
    return fail('wrangler se nepodařilo spustit');
  }
  if (result.code !== 0) {
    return fail(`stav D1 nejde přečíst (wrangler skončil kódem ${result.code}). Chybí přihlášení nebo oprávnění D1 Read? Deploy se zastavuje.`);
  }
  let state;
  try {
    state = parseRemoteState(result.stdout);
  } catch (error) {
    return fail(`stav D1 nejde přečíst: ${error instanceof Error ? error.message : String(error)}. Deploy se zastavuje.`);
  }
  if (state.environment !== target.environment) {
    return fail(`D1 ${target.database} má meta.environment = ${JSON.stringify(state.environment)}, očekává se "${target.environment}" – špatná databáze?`);
  }

  const diff = diffMigrations(local, state.applied);
  for (const name of diff.unknown) deps.log(`! v D1 je migrace, kterou tento kód nezná: ${name} (rollback nebo jiná větev – schéma musí zůstat zpětně kompatibilní)`);
  const destructive = new Map<string, string[]>();
  for (const name of diff.pending) {
    const reasons = destructiveReasons(readMigration(dir, name));
    if (reasons.length > 0) destructive.set(name, reasons);
  }
  if (diff.pending.length > 0) {
    deps.error(`✗ D1 ${target.database} nemá aplikované migrace:`);
    for (const name of diff.pending) deps.error(`    ${name}${destructive.has(name) ? `  [DESTRUKTIVNÍ: ${destructive.get(name)!.join(', ')}]` : ''}`);
    deps.error(`  Kód by běžel nad starým schématem. Nejdřív: pnpm run db:migrate:${target.name}`);
    return { ok: false, pending: diff.pending, destructive };
  }
  deps.log(`✓ D1 ${target.database}: všech ${local.length} migrací aplikováno, prostředí "${state.environment}"`);
  return { ok: true, pending: [], destructive };
}

/**
 * Ruční aplikace čekajících migrací. Jen v interaktivním terminálu mimo CI. Produkce: opsat název
 * databáze; destruktivní migrace v produkci: záloha (Time Travel bookmark + export) a fráze.
 * @returns exit kód
 */
export async function applyTarget(target: Target, deps: WorkflowDeps): Promise<number> {
  if (!deps.interactive) {
    deps.error('✗ Migrace se aplikují jen ručně v interaktivním terminálu, nikdy v CI ani v build pipeline.');
    return 1;
  }
  const before = await checkTarget(target, { ...deps, error: deps.log });
  if (before.pending.length === 0) {
    if (before.ok) deps.log('Nic k aplikaci.');
    else deps.error('✗ Stav D1 není v pořádku (viz výše) – migrace se neaplikují.');
    return before.ok ? 0 : 1;
  }

  const destructive = before.destructive.size > 0;
  if (target.name === 'production') {
    const typed = (await deps.prompt(`Aplikovat ${before.pending.length} migrací na PRODUKČNÍ D1? Opiš název databáze (${target.database}): `)).trim();
    if (typed !== target.database) {
      deps.error('✗ Název nesouhlasí – nic se neprovedlo.');
      return 1;
    }
    if (destructive) {
      const backup = await backupProduction(target, deps);
      if (!backup) return 1;
      deps.log(`Záloha: ${backup.file}`);
      deps.log(`Time Travel bookmark před migrací: ${backup.bookmark}`);
      deps.log(`Obnova v nouzi: npx wrangler d1 time-travel restore ${target.database} --bookmark=${backup.bookmark}`);
      const phrase = (await deps.prompt(`Destruktivní migrace. Ověř zálohu a opiš „${DESTRUCTIVE_CONFIRMATION}“: `)).trim();
      if (phrase !== DESTRUCTIVE_CONFIRMATION) {
        deps.error('✗ Potvrzení nesouhlasí – nic se neprovedlo.');
        return 1;
      }
    }
  } else if (destructive) {
    deps.log('! Destruktivní migrace na testovací D1 – ověř, že je to záměr (testovací data jsou jen syntetická).');
  }

  const applied = await deps.wrangler(['d1', 'migrations', 'apply', target.database, ...remote(target)], { interactive: true });
  if (applied.code !== 0) {
    deps.error(`✗ wrangler d1 migrations apply skončil kódem ${applied.code}`);
    return 1;
  }
  const after = await checkTarget(target, deps);
  return after.ok ? 0 : 1;
}

/** Bookmark Time Travel + SQL export produkční D1. Export obsahuje osobní údaje – .d1-backups/ je v .gitignore. */
async function backupProduction(target: Target, deps: WorkflowDeps): Promise<{ file: string; bookmark: string } | null> {
  deps.log('Destruktivní migrace → nejdřív záloha produkční D1 (bookmark + export).');
  const info = await deps.wrangler(['d1', 'time-travel', 'info', target.database, ...remote(target), '--json'], { interactive: false });
  let bookmark: unknown;
  try {
    bookmark = (JSON.parse(info.stdout.slice(info.stdout.indexOf('{'))) as { bookmark?: unknown }).bookmark;
  } catch {
    bookmark = undefined;
  }
  if (info.code !== 0 || typeof bookmark !== 'string' || bookmark === '') {
    deps.error('✗ Nepodařilo se získat Time Travel bookmark – migrace se neaplikuje.');
    return null;
  }
  const dir = join(deps.root, BACKUP_DIR);
  deps.mkdir(dir);
  const file = join(dir, `${target.database}-${deps.now().toISOString().replace(/[:.]/g, '-')}.sql`);
  const exported = await deps.wrangler(['d1', 'export', target.database, ...remote(target), '--output', file], { interactive: false });
  const size = deps.fileSize(file);
  if (exported.code !== 0 || size === null || size === 0) {
    deps.error('✗ Export D1 se nepodařil nebo je prázdný – migrace se neaplikuje.');
    return null;
  }
  return { file, bookmark };
}
