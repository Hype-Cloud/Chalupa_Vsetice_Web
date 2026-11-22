import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESTRUCTIVE_CONFIRMATION,
  destructiveReasons,
  diffMigrations,
  listLocalMigrations,
  parseJsonc,
  parseRemoteState,
  TARGETS,
  verifyConfigs,
} from '../scripts/lib/d1-migrations.ts';
import { applyTarget, authorizationProblems, backupOnly, checkTarget, exportProblems, parseApplyArgs, type ApplyAuthorization, type WorkflowDeps } from '../scripts/lib/d1-workflow.ts';

// Kontrola a řízená aplikace D1 migrací. Wrangler je falešný – žádné volání Cloudflare.
const ROOT = new URL('..', import.meta.url).pathname;
const LOCAL = [
  '0001_rezervace.sql',
  '0002_zruseni_uvolni_noci.sql',
  '0003_zruseni_sequence.sql',
  '0004_konflikty_rezervaci.sql',
  '0005_ceny.sql',
  '0006_ceny_pobytu.sql',
  '0007_poznamka_hosta.sql',
  '0008_kod_rezervace_platba.sql',
  '0009_jazyk_rezervace.sql',
  '0010_kalendar_pobytu.sql',
];
const WRANGLER = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
const PREVIEW_MIGRATIONS = readFileSync(join(ROOT, 'wrangler.preview-migrations.jsonc'), 'utf8');

/** Skutečný výstup `wrangler d1 execute --json` (zachycený z lokální D1). */
const executeOutput = (applied: string[], environment: string | null) =>
  JSON.stringify(
    [
      { results: applied.map((name) => ({ name })), success: true, meta: { duration: 0 } },
      { results: environment === null ? [] : [{ value: environment }], success: true, meta: { duration: 0 } },
    ],
    null,
    2,
  );

const tempMigrations = (names: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'migrace-'));
  for (const name of names) writeFileSync(join(dir, name), 'SELECT 1;');
  return dir;
};

test('migrace v repozitáři: souvislé číslování a formát názvu', () => {
  assert.deepEqual(listLocalMigrations(join(ROOT, 'migrations')), LOCAL);
  assert.deepEqual(listLocalMigrations(tempMigrations(['0002_b.sql', '0001_a.sql', 'README.md'])), ['0001_a.sql', '0002_b.sql']);
  assert.throws(() => listLocalMigrations(tempMigrations(['0001_a.sql', '0003_c.sql'])), /0003_c\.sql nenavazuje/);
  assert.throws(() => listLocalMigrations(tempMigrations(['0001_a.sql', '0001_b.sql'])), /0001_b\.sql nenavazuje/);
  assert.throws(() => listLocalMigrations(tempMigrations(['0001_a.sql', '2_spatne.sql'])), /neplatný název migrace: 2_spatne\.sql/);
  assert.throws(() => listLocalMigrations(tempMigrations(['0001_Velka-Pismena.sql'])), /neplatný název/);
});

test('JSONC: komentáře a koncové čárky, obsah řetězců beze změny', () => {
  assert.deepEqual(parseJsonc('{\n  // komentář\n  "a": "https://x.invalid/*ne*/", /* blok */ "b": [1, 2,],\n}'), { a: 'https://x.invalid/*ne*/', b: [1, 2] });
  assert.deepEqual(parseJsonc('{"s": "uvozovka \\" // není komentář"}'), { s: 'uvozovka " // není komentář' });
  const main = parseJsonc(WRANGLER) as { d1_databases: { database_name: string }[]; previews: { vars: Record<string, string> } };
  assert.equal(main.d1_databases[0].database_name, 'chalupa-vsetice-rezervace');
  assert.equal(main.previews.vars.BOOKING_ENV, 'preview');
});

test('konfigurace: skutečné wrangler soubory jsou konzistentní, produkční POST vypnutý', () => {
  assert.deepEqual(verifyConfigs(WRANGLER, PREVIEW_MIGRATIONS), []);
});

test('konfigurace: chyby oddělení prostředí se odhalí', () => {
  const previewId = 'b6269d5f-4705-4b4c-a52c-e5030a020605';
  const prodId = '08656b04-3ade-4a34-b9d3-94f7b8e154ef';
  const cases: [string, string, RegExp][] = [
    [WRANGLER.replace(previewId, prodId), PREVIEW_MIGRATIONS.replace(previewId, prodId), /sdílejí stejnou D1/],
    [WRANGLER, PREVIEW_MIGRATIONS.replace(previewId, '00000000-0000-0000-0000-000000000000'), /database_id se liší/],
    [WRANGLER.replace('"BOOKING_ENV": "production",', '"BOOKING_ENV": "production",\n    "BOOKING_API_ENABLED": "true",'), PREVIEW_MIGRATIONS, /produkční rezervační POST musí zůstat vypnutý/],
    [WRANGLER.replace('"BOOKING_ENV": "production"', '"BOOKING_ENV": "preview"'), PREVIEW_MIGRATIONS, /vars\.BOOKING_ENV musí být "production"/],
    [WRANGLER, PREVIEW_MIGRATIONS.replace('"name": "chalupa-vsetice-web",', '"name": "chalupa-vsetice-web",\n  "main": "./worker/index.ts",'), /nesmí mít "main"/],
    [WRANGLER, PREVIEW_MIGRATIONS.replace('"database_name": "chalupa-vsetice-rezervace-test"', '"database_name": "chalupa-vsetice-rezervace"'), /D1 musí být chalupa-vsetice-rezervace-test/],
  ];
  for (const [main, preview, expected] of cases) {
    const errors = verifyConfigs(main, preview);
    assert.ok(errors.some((e) => expected.test(e)), `${expected}: ${errors.join(' | ')}`);
  }
});

test('stav vzdálené D1: parsování výstupu wrangler d1 execute --json, jinak chyba', () => {
  assert.deepEqual(parseRemoteState(executeOutput(LOCAL, 'production')), { applied: LOCAL, environment: 'production' });
  assert.deepEqual(parseRemoteState(`▲ [WARNING] proxy\n${executeOutput(['0001_rezervace.sql'], null)}`), { applied: ['0001_rezervace.sql'], environment: null });
  for (const bad of [
    '{\n  "error": {\n    "text": "no such table: d1_migrations: SQLITE_ERROR"\n  }\n}',
    '',
    'Not logged in',
    '[{"results": [], "success": true}]',
    '[{"results": [], "success": false}, {"results": [], "success": true}]',
    '[{"results": [{"name": 7}], "success": true}, {"results": [], "success": true}]',
    '[nesmysl',
  ]) {
    assert.throws(() => parseRemoteState(bad), Error, bad);
  }
});

test('rozdíl migrací: čekající a neznámé', () => {
  assert.deepEqual(diffMigrations(LOCAL, LOCAL), { pending: [], unknown: [] });
  assert.deepEqual(diffMigrations(LOCAL, LOCAL.slice(0, 5)), { pending: LOCAL.slice(5), unknown: [] });
  assert.deepEqual(diffMigrations(LOCAL.slice(0, -1), LOCAL), { pending: [], unknown: [LOCAL.at(-1)!] });
  // Mezera uprostřed (aplikovaná pozdější migrace bez dřívější) je také čekající.
  assert.deepEqual(diffMigrations(LOCAL.slice(0, 3), [LOCAL[0], LOCAL[2]]), { pending: [LOCAL[1]], unknown: [] });
});

test('destruktivní migrace: skutečné migrace a syntetické případy', () => {
  const real = Object.fromEntries(LOCAL.map((name) => [name, destructiveReasons(readFileSync(join(ROOT, 'migrations', name), 'utf8'))]));
  assert.deepEqual(real, {
    '0001_rezervace.sql': [],
    // Jednorázový úklid nocí zrušených rezervací – mění data, tedy destruktivní.
    '0002_zruseni_uvolni_noci.sql': ['DELETE'],
    // Jen CREATE TRIGGER (UPDATE/DELETE v těle triggeru běží až při pozdějších zápisech).
    '0003_zruseni_sequence.sql': [],
    '0004_konflikty_rezervaci.sql': [],
    '0005_ceny.sql': [],
    '0006_ceny_pobytu.sql': [],
    '0007_poznamka_hosta.sql': [],
    // Nová tabulka a nullable sloupec – nedestruktivní.
    '0008_kod_rezervace_platba.sql': [],
    // Nullable sloupec – nedestruktivní.
    '0009_jazyk_rezervace.sql': [],
    '0010_kalendar_pobytu.sql': [],
  });
  const cases: [string, string[]][] = [
    ['DROP TABLE daily_prices;', ['DROP']],
    ['drop index idx_x;', ['DROP']],
    ['ALTER TABLE reservations DROP COLUMN note;', ['ALTER TABLE … DROP COLUMN']],
    ['ALTER TABLE reservations RENAME TO old_reservations;', ['ALTER TABLE … RENAME']],
    ['ALTER TABLE reservations RENAME COLUMN note TO guest_note;', ['ALTER TABLE … RENAME']],
    ['UPDATE reservations SET status = \'paid\';', ['UPDATE']],
    ['DELETE FROM daily_prices;', ['DELETE']],
    ["INSERT OR REPLACE INTO meta VALUES ('environment', 'x');", ['REPLACE']],
    ["REPLACE INTO meta VALUES ('a', 'b');", ['REPLACE']],
    // Přestavba tabulky (typický vzor SQLite) – víc důvodů najednou.
    ['CREATE TABLE r2 (id TEXT);\nINSERT INTO r2 SELECT id FROM reservations;\nDROP TABLE reservations;\nALTER TABLE r2 RENAME TO reservations;', ['DROP', 'ALTER TABLE … RENAME']],
    // Nedestruktivní.
    ['ALTER TABLE reservations ADD COLUMN x TEXT;', []],
    ['CREATE TABLE t (a TEXT); CREATE INDEX i ON t (a);', []],
    ["INSERT INTO meta (key, value) VALUES ('k', 'v');", []],
    ['-- DROP TABLE reservations; jen komentář\nCREATE TABLE t (a TEXT);', []],
    ['/* DELETE FROM x; */ CREATE TABLE t (a TEXT);', []],
    ["INSERT INTO meta VALUES ('text', 'DROP TABLE reservations; UPDATE x SET y');", []],
    ['CREATE TRIGGER t AFTER UPDATE OF status ON reservations BEGIN DELETE FROM reserved_nights WHERE reservation_id = NEW.id; END;', []],
    // Trigger se nesmí „spolknout“ i s destruktivním příkazem za ním.
    ['CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;\nDELETE FROM a;', ['DELETE']],
  ];
  for (const [sql, expected] of cases) assert.deepEqual(destructiveReasons(sql), expected, sql);
});

// check / apply nad falešným wranglerem

interface Fake {
  deps: WorkflowDeps;
  calls: string[][];
  out: string[];
  prompts: string[];
}

function fake(options: {
  target?: 'production' | 'preview';
  applied?: string[];
  environment?: string | null;
  interactive?: boolean;
  ci?: boolean;
  answers?: string[];
  executeCode?: number;
  executeStdout?: string;
  throwOnSpawn?: boolean;
  bookmark?: string | null;
  exportSize?: number | null;
  /** Obsah exportu; výchozí = platný export s aktuálně aplikovanými migracemi. */
  exportContent?: string;
  exportCode?: number;
  applyCode?: number;
  /** wrangler skončí 0, ale migrace v D1 nepřibudou. */
  applyNoop?: boolean;
}): Fake {
  let applied = options.applied ?? LOCAL;
  const environment = options.environment === undefined ? (options.target ?? 'production') : options.environment;
  const calls: string[][] = [];
  const out: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const files = new Map<string, { size: number; content: string }>();
  const deps: WorkflowDeps = {
    root: ROOT,
    interactive: options.interactive ?? true,
    ci: options.ci ?? false,
    wrangler: async (args) => {
      calls.push(args);
      if (options.throwOnSpawn) throw new Error('spawn ENOENT');
      const [, command] = args;
      if (command === 'execute') return { code: options.executeCode ?? 0, stdout: options.executeStdout ?? executeOutput(applied, environment) };
      if (command === 'migrations') {
        if ((options.applyCode ?? 0) === 0 && !options.applyNoop) applied = [...LOCAL];
        return { code: options.applyCode ?? 0, stdout: '' };
      }
      if (command === 'time-travel') {
        return options.bookmark === null ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ bookmark: options.bookmark ?? '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683', timestamp: '2026-10-08T10:00:00Z' }) };
      }
      if (command === 'export') {
        const file = args[args.indexOf('--output') + 1];
        if (options.exportSize !== null) files.set(file, { size: options.exportSize ?? 4096, content: options.exportContent ?? validExport(applied) });
        return { code: options.exportCode ?? 0, stdout: '' };
      }
      return { code: 1, stdout: '' };
    },
    prompt: async (question) => (prompts.push(question), answers.shift() ?? ''),
    fileSize: (path) => files.get(path)?.size ?? null,
    readFile: (path) => files.get(path)?.content ?? null,
    mkdir: () => undefined,
    now: () => new Date('2026-10-08T10:00:00.000Z'),
    log: (m) => out.push(m),
    error: (m) => out.push(m),
  };
  return { deps, calls, out, prompts };
}

/** Export ve tvaru `wrangler d1 export` (schéma + záznamy d1_migrations), jen syntetická data. */
function validExport(applied: string[]): string {
  return [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE d1_migrations(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n);',
    ...applied.map((name, i) => `INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(${i + 1},'${name}','2026-10-01 10:00:00');`),
    'CREATE TABLE reservations (\n  id TEXT PRIMARY KEY\n);',
    `INSERT INTO "meta" ("key","value") VALUES('environment','production');`,
  ].join('\n');
}

const commandOf = (args: string[]) => args.slice(0, args[1] === 'migrations' || args[1] === 'time-travel' ? 3 : 2).join(' ');

test('check: vše aplikováno → ok; jen jeden read-only dotaz na správnou DB s --remote', async () => {
  for (const name of ['production', 'preview'] as const) {
    const f = fake({ target: name });
    const result = await checkTarget(TARGETS[name], f.deps);
    assert.equal(result.ok, true, f.out.join('\n'));
    assert.equal(f.calls.length, 1);
    const [args] = f.calls;
    assert.deepEqual(args.slice(0, 7), ['d1', 'execute', TARGETS[name].database, '--remote', '--config', TARGETS[name].config, '--json']);
    const sql = args[args.indexOf('--command') + 1];
    assert.ok(sql.split(';').every((s) => /^\s*SELECT\b/i.test(s)), sql);
    assert.ok(f.out.some((l) => l.includes(`všech ${LOCAL.length} migrací aplikováno`)));
  }
});

test('check: čekající migrace → selže, vypíše je a označí destruktivní', async () => {
  const f = fake({ applied: LOCAL.slice(0, -1) });
  const result = await checkTarget(TARGETS.production, f.deps);
  assert.equal(result.ok, false);
  assert.deepEqual(result.pending, [LOCAL.at(-1)]);
  assert.ok(f.out.some((l) => l.trim() === LOCAL.at(-1)), f.out.join('\n'));
  assert.ok(f.out.some((l) => l.includes('pnpm run db:migrate:production')));

  const g = fake({ applied: [LOCAL[0]] });
  const destructive = await checkTarget(TARGETS.production, g.deps);
  assert.equal(destructive.ok, false);
  assert.deepEqual([...destructive.destructive.keys()], ['0002_zruseni_uvolni_noci.sql']);
  assert.ok(g.out.some((l) => l.includes('0002_zruseni_uvolni_noci.sql  [DESTRUKTIVNÍ: DELETE]')), g.out.join('\n'));
});

test('check: fail-closed při chybě wrangleru, nečitelné odpovědi, špatném prostředí nebo prázdné DB', async () => {
  const cases: [Parameters<typeof fake>[0], RegExp][] = [
    [{ executeCode: 1, executeStdout: '' }, /nejde přečíst.*D1 Read/],
    [{ executeStdout: '{"error": {"text": "no such table: d1_migrations"}}' }, /nejde přečíst/],
    [{ executeStdout: 'Authentication error [code: 10000]' }, /nejde přečíst/],
    [{ throwOnSpawn: true }, /wrangler se nepodařilo spustit/],
    [{ environment: 'preview' }, /meta\.environment = "preview", očekává se "production"/],
    [{ environment: null }, /meta\.environment = null/],
  ];
  for (const [options, expected] of cases) {
    const f = fake(options);
    assert.equal((await checkTarget(TARGETS.production, f.deps)).ok, false, JSON.stringify(options));
    assert.ok(f.out.some((l) => expected.test(l)), `${expected}\n${f.out.join('\n')}`);
  }
  // Preview build nesmí projít kontrolou proti produkční databázi.
  const f = fake({ target: 'preview', environment: 'production' });
  assert.equal((await checkTarget(TARGETS.preview, f.deps)).ok, false);
});

test('check: migrace v D1, které kód nezná (rollback) → jen varování', async () => {
  const f = fake({ applied: [...LOCAL, '0008_budouci.sql'] });
  assert.equal((await checkTarget(TARGETS.production, f.deps)).ok, true);
  assert.ok(f.out.some((l) => l.includes('0008_budouci.sql') && l.includes('zpětně kompatibilní')));
});

test('apply: bez terminálu a bez explicitní autorizace se nic nespustí', async () => {
  for (const target of ['production', 'preview'] as const) {
    const f = fake({ target, applied: LOCAL.slice(0, -1), interactive: false });
    assert.equal(await applyTarget(TARGETS[target], f.deps), 1);
    assert.deepEqual(f.calls, [], 'žádné volání wrangleru');
    assert.ok(f.out.some((l) => l.includes('--non-interactive') && l.includes('nikdy v CI')));
  }
});

test('apply: nic čekajícího → nic se neaplikuje; chybný stav D1 → nic se neaplikuje', async () => {
  const f = fake({});
  assert.equal(await applyTarget(TARGETS.production, f.deps), 0);
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute']);
  assert.deepEqual(f.prompts, []);
  const g = fake({ environment: 'preview' });
  assert.equal(await applyTarget(TARGETS.production, g.deps), 1);
  assert.deepEqual(g.calls.map(commandOf), ['d1 execute']);
});

test('apply preview: bez opisování názvu, aplikace na testovací DB a nová kontrola', async () => {
  const f = fake({ target: 'preview', applied: LOCAL.slice(0, -1) });
  assert.equal(await applyTarget(TARGETS.preview, f.deps), 0);
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 migrations apply', 'd1 execute']);
  assert.deepEqual(f.calls[1], ['d1', 'migrations', 'apply', 'chalupa-vsetice-rezervace-test', '--remote', '--config', 'wrangler.preview-migrations.jsonc']);
  assert.deepEqual(f.prompts, []);
});

test('apply produkce: bez opsaného názvu databáze se nic neprovede', async () => {
  for (const answer of ['', 'ano', 'y', 'chalupa-vsetice-rezervace-test', 'CHALUPA-VSETICE-REZERVACE']) {
    const f = fake({ applied: LOCAL.slice(0, -1), answers: [answer] });
    assert.equal(await applyTarget(TARGETS.production, f.deps), 1, answer);
    assert.deepEqual(f.calls.map(commandOf), ['d1 execute'], answer);
  }
});

test('apply produkce: nedestruktivní migrace po opsání názvu – vždy nejdřív ověřená záloha', async () => {
  const f = fake({ applied: LOCAL.slice(0, -1), answers: ['chalupa-vsetice-rezervace'] });
  assert.equal(await applyTarget(TARGETS.production, f.deps), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 time-travel info', 'd1 export', 'd1 migrations apply', 'd1 execute']);
  // time-travel info pracuje se vzdálenou D1 a --remote nezná.
  assert.deepEqual(f.calls[1], ['d1', 'time-travel', 'info', 'chalupa-vsetice-rezervace', '--config', 'wrangler.jsonc', '--json']);
  assert.deepEqual(f.calls[3], ['d1', 'migrations', 'apply', 'chalupa-vsetice-rezervace', '--remote', '--config', 'wrangler.jsonc']);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.out.some((l) => l.startsWith('✓ Záloha ověřena:') && l.includes(`${LOCAL.length - 1} aplikovaných migrací`)), f.out.join('\n'));
  assert.ok(f.out.some((l) => l.includes('time-travel restore chalupa-vsetice-rezervace --bookmark=00000085-')));
});

test('apply produkce: destruktivní migrace → bookmark, export, potvrzovací fráze, teprve pak aplikace', async () => {
  const f = fake({ applied: [LOCAL[0]], answers: ['chalupa-vsetice-rezervace', DESTRUCTIVE_CONFIRMATION] });
  assert.equal(await applyTarget(TARGETS.production, f.deps), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 time-travel info', 'd1 export', 'd1 migrations apply', 'd1 execute']);
  const exportArgs = f.calls[2];
  assert.deepEqual(exportArgs.slice(0, 6), ['d1', 'export', 'chalupa-vsetice-rezervace', '--remote', '--config', 'wrangler.jsonc']);
  assert.equal(exportArgs[exportArgs.indexOf('--output') + 1], join(ROOT, '.d1-backups', 'chalupa-vsetice-rezervace-2026-10-08T10-00-00-000Z.sql'));
  assert.ok(f.out.some((l) => l.includes('time-travel restore chalupa-vsetice-rezervace --bookmark=00000085-')));
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts[1].includes(DESTRUCTIVE_CONFIRMATION));
});

test('apply produkce: bez platné a ověřené zálohy nebo bez potvrzení se nic neaplikuje', async () => {
  const backupCalls = ['d1 execute', 'd1 time-travel info', 'd1 export'];
  const cases: [Parameters<typeof fake>[0], string[]][] = [
    [{ bookmark: null }, ['d1 execute', 'd1 time-travel info']],
    [{ bookmark: 'neplatny-bookmark' }, ['d1 execute', 'd1 time-travel info']],
    [{ exportSize: null }, backupCalls],
    [{ exportSize: 0 }, backupCalls],
    [{ exportCode: 1 }, backupCalls],
    [{ exportContent: 'CREATE TABLE d1_migrations (id INTEGER);' }, backupCalls],
    [{ exportContent: validExport([LOCAL[0]]).replace('CREATE TABLE reservations', 'CREATE TABLE jina') }, backupCalls],
    [{ answers: ['chalupa-vsetice-rezervace', 'ano'] }, backupCalls],
  ];
  for (const [options, expectedCalls] of cases) {
    const f = fake({ applied: [LOCAL[0]], answers: ['chalupa-vsetice-rezervace', DESTRUCTIVE_CONFIRMATION], ...options });
    assert.equal(await applyTarget(TARGETS.production, f.deps), 1, JSON.stringify(options));
    assert.deepEqual(f.calls.map(commandOf), expectedCalls, JSON.stringify(options));
  }
  // Export, ve kterém chybí některá aplikovaná migrace (neúplná záloha).
  const g = fake({ applied: LOCAL.slice(0, -1), answers: ['chalupa-vsetice-rezervace'], exportContent: validExport(LOCAL.slice(0, -2)) });
  assert.equal(await applyTarget(TARGETS.production, g.deps), 1);
  assert.ok(g.out.some((l) => l.includes(`v exportu chybí záznam migrací: ${LOCAL.at(-2)}`)), g.out.join('\n'));
  assert.ok(!g.calls.some((c) => c[1] === 'migrations'));
});

// Neinteraktivní režim s explicitní autorizací

const AUTH_PROD = (expect: string[], allowDestructive: string[] = []): ApplyAuthorization => ({ database: 'chalupa-vsetice-rezervace', expect, allowDestructive });

test('apply: v CI se migrace neaplikují v žádném režimu (ani s autorizací)', async () => {
  for (const authorization of [undefined, AUTH_PROD([LOCAL.at(-1)!])]) {
    const f = fake({ applied: LOCAL.slice(0, -1), ci: true, interactive: false });
    assert.equal(await applyTarget(TARGETS.production, f.deps, authorization), 1);
    assert.deepEqual(f.calls, []);
    assert.ok(f.out.some((l) => l.includes('nikdy neaplikují v CI')));
  }
});

test('apply neinteraktivně (produkce, aditivní): autorizace → ověřená záloha → aplikace → kontrola; bez promptů', async () => {
  const pending = LOCAL.slice(-2);
  const f = fake({ applied: LOCAL.slice(0, -2), interactive: false });
  assert.equal(await applyTarget(TARGETS.production, f.deps, AUTH_PROD(pending)), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 time-travel info', 'd1 export', 'd1 migrations apply', 'd1 execute']);
  assert.deepEqual(f.prompts, []);
  assert.ok(f.out.some((l) => l.includes(`Autorizováno neinteraktivně: chalupa-vsetice-rezervace, migrace ${pending.join(', ')}`)));
  assert.ok(f.out.some((l) => l.startsWith('✓ Záloha ověřena:')));
  assert.ok(f.out.some((l) => l.includes('všech') && l.includes('migrací aplikováno')));
});

test('apply neinteraktivně: autorizace, která neodpovídá stavu D1, nic nespustí (jen čtení stavu)', async () => {
  const pending = LOCAL.slice(-2);
  const cases: [ApplyAuthorization, Parameters<typeof fake>[0], RegExp][] = [
    [{ ...AUTH_PROD(pending), database: 'chalupa-vsetice-rezervace-test' }, {}, /neodpovídá cílové databázi/],
    [AUTH_PROD([LOCAL.at(-1)!]), {}, /neodpovídají --expect/],
    [AUTH_PROD([...pending].reverse()), {}, /neodpovídají --expect/],
    [AUTH_PROD([...pending, '0010_neexistuje.sql']), {}, /neodpovídají --expect/],
    [AUTH_PROD(pending, [LOCAL.at(-1)!]), {}, /neodpovídá žádné čekající destruktivní/],
    [AUTH_PROD(pending), { applied: [...LOCAL.slice(0, -2), '0099_jina_vetev.sql'] }, /migrace, které kód nezná/],
  ];
  for (const [authorization, options, expected] of cases) {
    const f = fake({ applied: LOCAL.slice(0, -2), interactive: false, ...options });
    assert.equal(await applyTarget(TARGETS.production, f.deps, authorization), 1, JSON.stringify(authorization));
    assert.deepEqual(f.calls.map(commandOf), ['d1 execute'], JSON.stringify(authorization));
    assert.ok(f.out.some((l) => expected.test(l)), `${expected}\n${f.out.join('\n')}`);
  }
});

test('apply neinteraktivně: destruktivní migrace – přísnější režim (výslovné povolení, v produkci samostatně, záloha)', async () => {
  const destructive = '0002_zruseni_uvolni_noci.sql';
  // Bez --allow-destructive nebo s dalšími migracemi v témže běhu → nic.
  const multi = fake({ applied: [LOCAL[0]], interactive: false });
  assert.equal(await applyTarget(TARGETS.production, multi.deps, AUTH_PROD(LOCAL.slice(1), [destructive])), 1);
  assert.ok(multi.out.some((l) => l.includes('jen samostatně')), multi.out.join('\n'));
  assert.deepEqual(multi.calls.map(commandOf), ['d1 execute']);
  const onlyDestructive = LOCAL.filter((m) => m !== destructive);
  const denied = fake({ applied: onlyDestructive, interactive: false });
  assert.equal(await applyTarget(TARGETS.production, denied.deps, AUTH_PROD([destructive])), 1);
  assert.ok(denied.out.some((l) => l.includes(`vyžadují přesně --allow-destructive=${destructive}`)));
  assert.deepEqual(denied.calls.map(commandOf), ['d1 execute']);
  // Samostatná, výslovně povolená destruktivní migrace → záloha, aplikace; bez promptu.
  const ok = fake({ applied: onlyDestructive, interactive: false });
  assert.equal(await applyTarget(TARGETS.production, ok.deps, AUTH_PROD([destructive], [destructive])), 0, ok.out.join('\n'));
  assert.deepEqual(ok.calls.map(commandOf), ['d1 execute', 'd1 time-travel info', 'd1 export', 'd1 migrations apply', 'd1 execute']);
  assert.deepEqual(ok.prompts, []);
  // Selhání zálohy → nic se neaplikuje.
  const noBackup = fake({ applied: onlyDestructive, interactive: false, exportSize: 0 });
  assert.equal(await applyTarget(TARGETS.production, noBackup.deps, AUTH_PROD([destructive], [destructive])), 1);
  assert.ok(!noBackup.calls.some((c) => c[1] === 'migrations'));
});

test('apply neinteraktivně (preview): bez zálohy, destruktivní jen s výslovným povolením; DB musí odpovídat', async () => {
  const auth = (expect: string[], allowDestructive: string[] = []): ApplyAuthorization => ({ database: 'chalupa-vsetice-rezervace-test', expect, allowDestructive });
  const f = fake({ target: 'preview', applied: LOCAL.slice(0, -1), interactive: false });
  assert.equal(await applyTarget(TARGETS.preview, f.deps, auth([LOCAL.at(-1)!])), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 migrations apply', 'd1 execute']);
  // Produkční název DB pro preview cíl → nic.
  const wrong = fake({ target: 'preview', applied: LOCAL.slice(0, -1), interactive: false });
  assert.equal(await applyTarget(TARGETS.preview, wrong.deps, AUTH_PROD([LOCAL.at(-1)!])), 1);
  assert.deepEqual(wrong.calls.map(commandOf), ['d1 execute']);
  // Destruktivní bez povolení → nic; s povolením → aplikace (na preview může být víc migrací najednou).
  const d = fake({ target: 'preview', applied: [LOCAL[0]], interactive: false });
  assert.equal(await applyTarget(TARGETS.preview, d.deps, auth(LOCAL.slice(1))), 1);
  const dOk = fake({ target: 'preview', applied: [LOCAL[0]], interactive: false });
  assert.equal(await applyTarget(TARGETS.preview, dOk.deps, auth(LOCAL.slice(1), ['0002_zruseni_uvolni_noci.sql'])), 0, dOk.out.join('\n'));
});

test('parseApplyArgs: autorizace jen s --non-interactive a povinnými údaji', () => {
  assert.deepEqual(parseApplyArgs([]), {});
  assert.deepEqual(parseApplyArgs(['--non-interactive', '--database=chalupa-vsetice-rezervace', '--expect=0009_a.sql, 0010_b.sql']), {
    authorization: { database: 'chalupa-vsetice-rezervace', expect: ['0009_a.sql', '0010_b.sql'], allowDestructive: [] },
  });
  assert.deepEqual(parseApplyArgs(['--non-interactive', '--database=x', '--expect=0002_a.sql', '--allow-destructive=0002_a.sql']).authorization?.allowDestructive, ['0002_a.sql']);
  const errors: [string[], RegExp][] = [
    [['--database=x'], /jen s --non-interactive/],
    [['--non-interactive'], /vyžaduje --database/],
    [['--non-interactive', '--database=x'], /vyžaduje --expect/],
    [['--non-interactive', '--database=x', '--expect='], /vyžaduje --expect/],
    [['--non-interactive', '--database=x', '--expect=a.sql,a.sql'], /duplicitní/],
    [['--non-interactive', '--database=x', '--database=y', '--expect=a.sql'], /vícekrát/],
    [['--non-interactive', '--database=x', '--expect=a.sql', '--yes'], /neznámý argument: --yes/],
    [['--non-interactive', '--database', 'x'], /neznámý argument/],
  ];
  for (const [args, expected] of errors) assert.match(parseApplyArgs(args).error ?? '', expected, args.join(' '));
});

test('authorizationProblems a exportProblems: přímé kontroly', () => {
  const check = { ok: false, applied: [LOCAL[0]], pending: LOCAL.slice(1), unknown: [], destructive: new Map([['0002_zruseni_uvolni_noci.sql', ['DELETE']]]) };
  assert.deepEqual(authorizationProblems(TARGETS.preview, check, { database: 'chalupa-vsetice-rezervace-test', expect: LOCAL.slice(1), allowDestructive: ['0002_zruseni_uvolni_noci.sql'] }), []);
  assert.equal(authorizationProblems(TARGETS.production, check, AUTH_PROD(LOCAL.slice(1), ['0002_zruseni_uvolni_noci.sql'])).length, 1);
  assert.deepEqual(exportProblems(validExport(LOCAL), LOCAL), []);
  assert.deepEqual(exportProblems(null, LOCAL), ['export nejde přečíst']);
  assert.deepEqual(exportProblems('CREATE TABLE "reservations" (id TEXT); CREATE TABLE IF NOT EXISTS `d1_migrations` (id INTEGER);', []), []);
  assert.deepEqual(exportProblems('', [LOCAL[0]]), ['chybí schéma tabulky reservations', 'chybí schéma tabulky d1_migrations', `v exportu chybí záznam migrací: ${LOCAL[0]}`]);
});

test('backup: ověřená záloha bez migrace; v CI nic; nečitelný stav D1 → nic', async () => {
  const f = fake({ target: 'preview' });
  assert.equal(await backupOnly(TARGETS.preview, f.deps), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 time-travel info', 'd1 export']);
  assert.deepEqual(f.calls[1], ['d1', 'time-travel', 'info', 'chalupa-vsetice-rezervace-test', '--config', 'wrangler.preview-migrations.jsonc', '--json']);
  const ci = fake({ ci: true });
  assert.equal(await backupOnly(TARGETS.production, ci.deps), 1);
  assert.deepEqual(ci.calls, []);
  const broken = fake({ executeCode: 1, executeStdout: '' });
  assert.equal(await backupOnly(TARGETS.production, broken.deps), 1);
  assert.deepEqual(broken.calls.map(commandOf), ['d1 execute']);
});

test('apply: selhání wrangler d1 migrations apply → exit 1; „úspěch“ bez změny v D1 → exit 1', async () => {
  const f = fake({ target: 'preview', applied: LOCAL.slice(0, -1), applyCode: 1 });
  assert.equal(await applyTarget(TARGETS.preview, f.deps), 1);
  assert.ok(f.out.some((l) => l.includes('skončil kódem 1')));
  const noop = fake({ applied: LOCAL.slice(0, -1), interactive: false, applyNoop: true });
  assert.equal(await applyTarget(TARGETS.production, noop.deps, AUTH_PROD([LOCAL.at(-1)!])), 1);
  assert.ok(noop.out.some((l) => l.includes('nemá aplikované migrace')), noop.out.join('\n'));
});

test('package.json: deploy skripty spouští kontrolu migrací před nasazením', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(scripts.deploy, /^node scripts\/d1-migrations\.ts check production && wrangler deploy --config wrangler\.jsonc$/);
  assert.match(scripts['deploy:preview'], /^node scripts\/d1-migrations\.ts check preview && wrangler preview --config wrangler\.jsonc$/);
  // Žádný skript nespouští migrace automaticky před nebo po deployi.
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith('db:migrate:')) continue;
    assert.ok(!/migrations apply|d1-migrations\.ts apply/.test(command), `${name}: ${command}`);
  }
  assert.ok(!('predeploy' in scripts) && !('postdeploy' in scripts));
});

test('.gitignore: zálohy D1 se necommitují', () => {
  assert.ok(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').includes('.d1-backups/'));
});
