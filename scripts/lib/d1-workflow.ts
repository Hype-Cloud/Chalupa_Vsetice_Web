// Průběh `check`, `backup` a `apply` nad injektovanými závislostmi (wrangler, terminál, soubory).
//
// apply má dva režimy, oba mimo CI a build pipeline:
// - interaktivní (TTY): produkce vyžaduje opsání názvu DB, destruktivní migrace navíc frázi;
// - neinteraktivní s explicitní autorizací (ApplyAuthorization) pro automatizaci (agent,
//   skript): název DB, přesný seznam čekajících migrací (--expect) a u destruktivních migrací
//   jejich výslovné povolení (--allow-destructive); destruktivní migrace v produkci jen samostatně.
// Produkce v obou režimech vždy nejdřív ověřená záloha (Time Travel bookmark + export).

import { join } from 'node:path';
import {
  BACKUP_DIR,
  BOOKMARK,
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
  /** Interaktivní terminál mimo CI. Bez něj se migrace interaktivně neaplikují. */
  interactive: boolean;
  /** Běh v CI nebo Workers Builds – migrace se tam neaplikují v žádném režimu. */
  ci: boolean;
  prompt: (question: string) => Promise<string>;
  /** Velikost souboru v bajtech, nebo null, když neexistuje. */
  fileSize: (path: string) => number | null;
  /** Obsah souboru (ověření exportu), nebo null. Obsah se nikdy nevypisuje. */
  readFile: (path: string) => string | null;
  mkdir: (path: string) => void;
  now: () => Date;
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface CheckResult {
  ok: boolean;
  /** Migrace aplikované v D1 (prázdné, pokud stav nejde přečíst). */
  applied: string[];
  pending: string[];
  /** V D1, ale ne v repozitáři (rollback, jiná větev). */
  unknown: string[];
  /** Čekající migrace → důvody destruktivity (jen destruktivní). */
  destructive: Map<string, string[]>;
}

const remote = (target: Target) => ['--remote', '--config', target.config];

/** Jen čtení: porovná migrace v repozitáři se stavem cílové D1. Chyba = ok: false (fail-closed). */
export async function checkTarget(target: Target, deps: WorkflowDeps): Promise<CheckResult> {
  const fail = (message: string): CheckResult => {
    deps.error(`✗ ${message}`);
    return { ok: false, applied: [], pending: [], unknown: [], destructive: new Map() };
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
    return { ok: false, applied: state.applied, pending: diff.pending, unknown: diff.unknown, destructive };
  }
  deps.log(`✓ D1 ${target.database}: všech ${local.length} migrací aplikováno, prostředí "${state.environment}"`);
  return { ok: true, applied: state.applied, pending: [], unknown: diff.unknown, destructive };
}

/** Explicitní autorizace neinteraktivní aplikace (CLI: --non-interactive --database … --expect …). */
export interface ApplyAuthorization {
  /** Název cílové databáze – musí přesně odpovídat cíli (náhrada interaktivního opsání). */
  database: string;
  /** Přesný seznam čekajících migrací v pořadí aplikace; jiný stav D1 = nic se neprovede. */
  expect: string[];
  /** Destruktivní migrace výslovně povolené pro tento běh; musí přesně odpovídat čekajícím destruktivním. */
  allowDestructive: string[];
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Důvody, proč autorizace neodpovídá stavu D1 (prázdné = lze aplikovat). */
export function authorizationProblems(target: Target, check: CheckResult, auth: ApplyAuthorization): string[] {
  const problems: string[] = [];
  if (auth.database !== target.database) problems.push(`--database "${auth.database}" neodpovídá cílové databázi ${target.database}`);
  if (check.unknown.length > 0) problems.push(`D1 obsahuje migrace, které kód nezná (${check.unknown.join(', ')}) – neinteraktivně se neaplikuje`);
  if (!same(auth.expect, check.pending)) {
    problems.push(`čekající migrace (${check.pending.join(', ') || 'žádné'}) neodpovídají --expect (${auth.expect.join(', ') || 'nic'})`);
  }
  const destructive = [...check.destructive.keys()];
  const allowed = [...auth.allowDestructive].sort();
  if (!same(allowed, [...destructive].sort())) {
    problems.push(
      destructive.length > 0
        ? `destruktivní migrace (${destructive.join(', ')}) vyžadují přesně --allow-destructive=${destructive.join(',')}`
        : `--allow-destructive (${allowed.join(', ')}) neodpovídá žádné čekající destruktivní migraci`,
    );
  }
  if (target.name === 'production' && destructive.length > 0 && check.pending.length > 1) {
    problems.push('destruktivní migraci lze v produkci aplikovat jen samostatně (jedna migrace na běh)');
  }
  return problems;
}

/**
 * Aplikace čekajících migrací. Nikdy v CI. Bez `authorization` jen v interaktivním terminálu
 * (produkce: opsat název DB; destruktivní: fráze). S `authorization` neinteraktivně po kontrole
 * autorizace proti skutečnému stavu D1. Produkce vždy po ověřené záloze.
 * @returns exit kód
 */
export async function applyTarget(target: Target, deps: WorkflowDeps, authorization?: ApplyAuthorization): Promise<number> {
  if (deps.ci) {
    deps.error('✗ Migrace se nikdy neaplikují v CI ani v build pipeline.');
    return 1;
  }
  if (!authorization && !deps.interactive) {
    deps.error('✗ Migrace se aplikují jen v interaktivním terminálu, nebo neinteraktivně s explicitní autorizací (--non-interactive --database … --expect …); nikdy v CI ani v build pipeline.');
    return 1;
  }
  const before = await checkTarget(target, { ...deps, error: deps.log });
  if (before.pending.length === 0) {
    if (before.ok) deps.log('Nic k aplikaci.');
    else deps.error('✗ Stav D1 není v pořádku (viz výše) – migrace se neaplikují.');
    return before.ok ? 0 : 1;
  }
  if (authorization) {
    const problems = authorizationProblems(target, before, authorization);
    if (problems.length > 0) {
      deps.error(`✗ Autorizace neodpovídá stavu D1 – nic se neprovedlo:\n  ${problems.join('\n  ')}`);
      return 1;
    }
    deps.log(`Autorizováno neinteraktivně: ${target.database}, migrace ${before.pending.join(', ')}`);
  }

  const destructive = before.destructive.size > 0;
  if (target.name === 'production') {
    if (!authorization) {
      const typed = (await deps.prompt(`Aplikovat ${before.pending.length} migrací na PRODUKČNÍ D1? Opiš název databáze (${target.database}): `)).trim();
      if (typed !== target.database) {
        deps.error('✗ Název nesouhlasí – nic se neprovedlo.');
        return 1;
      }
    }
    const backup = await backupTarget(target, deps, before.applied);
    if (!backup) return 1;
    if (destructive && !authorization) {
      const phrase = (await deps.prompt(`Destruktivní migrace. Ověř zálohu a opiš „${DESTRUCTIVE_CONFIRMATION}“: `)).trim();
      if (phrase !== DESTRUCTIVE_CONFIRMATION) {
        deps.error('✗ Potvrzení nesouhlasí – nic se neprovedlo.');
        return 1;
      }
    }
  } else if (destructive) {
    deps.log('! Destruktivní migrace na testovací D1 – ověř, že je to záměr (testovací data jsou jen syntetická).');
  }

  const interactive = !authorization;
  const applied = await deps.wrangler(['d1', 'migrations', 'apply', target.database, ...remote(target)], { interactive });
  if (!interactive && applied.stdout.trim()) deps.log(applied.stdout.trim());
  if (applied.code !== 0) {
    deps.error(`✗ wrangler d1 migrations apply skončil kódem ${applied.code}`);
    return 1;
  }
  // Kontrola po aplikaci: žádná čekající migrace = všechny autorizované migrace jsou v D1.
  const after = await checkTarget(target, deps);
  return after.ok ? 0 : 1;
}

export interface Backup {
  file: string;
  bookmark: string;
  bytes: number;
}

/**
 * Ověřená záloha D1 před migrací: Time Travel bookmark (obnova na straně Cloudflare) + SQL export
 * do .d1-backups/ (osobní údaje – v .gitignore, po ověření migrace smazat). Export musí obsahovat
 * schéma `reservations` a `d1_migrations` a všechny migrace aplikované v D1; jinak null.
 * `applied` = stav D1 přečtený těsně před zálohou.
 */
export async function backupTarget(target: Target, deps: WorkflowDeps, applied: readonly string[]): Promise<Backup | null> {
  deps.log(`Záloha D1 ${target.database} (Time Travel bookmark + export).`);
  // time-travel info pracuje vždy se vzdálenou D1 (wrangler nezná --remote).
  const info = await deps.wrangler(['d1', 'time-travel', 'info', target.database, '--config', target.config, '--json'], { interactive: false });
  let bookmark: unknown;
  try {
    bookmark = (JSON.parse(info.stdout.slice(info.stdout.indexOf('{'))) as { bookmark?: unknown }).bookmark;
  } catch {
    bookmark = undefined;
  }
  if (info.code !== 0 || typeof bookmark !== 'string' || !BOOKMARK.test(bookmark)) {
    deps.error('✗ Nepodařilo se získat platný Time Travel bookmark – migrace se neaplikuje.');
    return null;
  }
  const dir = join(deps.root, BACKUP_DIR);
  deps.mkdir(dir);
  const file = join(dir, `${target.database}-${deps.now().toISOString().replace(/[:.]/g, '-')}.sql`);
  const exported = await deps.wrangler(['d1', 'export', target.database, ...remote(target), '--output', file], { interactive: false });
  const bytes = deps.fileSize(file);
  if (exported.code !== 0 || bytes === null || bytes === 0) {
    deps.error(`✗ Export D1 se nepodařil nebo je prázdný${exported.code !== 0 ? ` (wrangler skončil kódem ${exported.code}; chybí oprávnění D1 Edit?)` : ''} – migrace se neaplikuje.`);
    return null;
  }
  const problems = exportProblems(deps.readFile(file), applied);
  if (problems.length > 0) {
    deps.error(`✗ Export D1 neprošel ověřením – migrace se neaplikuje:\n  ${problems.join('\n  ')}`);
    return null;
  }
  deps.log(`✓ Záloha ověřena: ${file} (${bytes} B, ${applied.length} aplikovaných migrací v exportu)`);
  deps.log(`Time Travel bookmark před migrací: ${bookmark}`);
  deps.log(`Obnova v nouzi: npx wrangler d1 time-travel restore ${target.database} --bookmark=${bookmark} --config ${target.config}`);
  return { file, bookmark, bytes };
}

/** Kontrola obsahu exportu (jen struktura a názvy migrací, žádná data se nevypisují). */
export function exportProblems(sql: string | null, applied: readonly string[]): string[] {
  if (sql === null) return ['export nejde přečíst'];
  const problems: string[] = [];
  for (const table of ['reservations', 'd1_migrations']) {
    if (!new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["'\`[]?${table}["'\`\\]]?\\s*\\(`, 'i').test(sql)) problems.push(`chybí schéma tabulky ${table}`);
  }
  const missing = applied.filter((name) => !sql.includes(`'${name}'`));
  if (missing.length > 0) problems.push(`v exportu chybí záznam migrací: ${missing.join(', ')}`);
  return problems;
}

/** Ruční záloha bez migrace (CLI `backup`): stejné ověření jako před migrací. */
export async function backupOnly(target: Target, deps: WorkflowDeps): Promise<number> {
  if (deps.ci) {
    deps.error('✗ Zálohy se nespouští v CI ani v build pipeline.');
    return 1;
  }
  const state = await checkTarget(target, { ...deps, error: deps.log });
  if (state.applied.length === 0) {
    deps.error('✗ Stav D1 nejde přečíst – záloha se nevytvoří.');
    return 1;
  }
  return (await backupTarget(target, deps, state.applied)) ? 0 : 1;
}

/** Argumenty `apply` za cílem → autorizace (jen s --non-interactive), nebo chyba. */
export function parseApplyArgs(args: readonly string[]): { authorization?: ApplyAuthorization; error?: string } {
  const flags = new Map<string, string>();
  let nonInteractive = false;
  for (const arg of args) {
    if (arg === '--non-interactive') nonInteractive = true;
    else {
      const match = /^--(database|expect|allow-destructive)=(.*)$/.exec(arg);
      if (!match) return { error: `neznámý argument: ${arg}` };
      if (flags.has(match[1])) return { error: `--${match[1]} je zadaný vícekrát` };
      flags.set(match[1], match[2]);
    }
  }
  if (!nonInteractive) return flags.size > 0 ? { error: '--database/--expect/--allow-destructive jen s --non-interactive' } : {};
  const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const database = flags.get('database')?.trim();
  const expect = list(flags.get('expect'));
  if (!database) return { error: '--non-interactive vyžaduje --database=<název databáze>' };
  if (expect.length === 0) return { error: '--non-interactive vyžaduje --expect=<migrace,…> (přesný seznam čekajících migrací)' };
  if (new Set(expect).size !== expect.length) return { error: '--expect obsahuje duplicitní migraci' };
  return { authorization: { database, expect, allowDestructive: list(flags.get('allow-destructive')) } };
}
