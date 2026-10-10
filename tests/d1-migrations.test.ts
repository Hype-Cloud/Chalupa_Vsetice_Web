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
import { applyTarget, checkTarget, type WorkflowDeps } from '../scripts/lib/d1-workflow.ts';

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
  answers?: string[];
  executeCode?: number;
  executeStdout?: string;
  throwOnSpawn?: boolean;
  bookmark?: string | null;
  exportSize?: number | null;
  applyCode?: number;
}): Fake {
  let applied = options.applied ?? LOCAL;
  const environment = options.environment === undefined ? (options.target ?? 'production') : options.environment;
  const calls: string[][] = [];
  const out: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const files = new Map<string, number>();
  const deps: WorkflowDeps = {
    root: ROOT,
    interactive: options.interactive ?? true,
    wrangler: async (args) => {
      calls.push(args);
      if (options.throwOnSpawn) throw new Error('spawn ENOENT');
      const [, command] = args;
      if (command === 'execute') return { code: options.executeCode ?? 0, stdout: options.executeStdout ?? executeOutput(applied, environment) };
      if (command === 'migrations') {
        if ((options.applyCode ?? 0) === 0) applied = [...LOCAL];
        return { code: options.applyCode ?? 0, stdout: '' };
      }
      if (command === 'time-travel') {
        return options.bookmark === null ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ bookmark: options.bookmark ?? '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683', timestamp: '2026-10-08T10:00:00Z' }) };
      }
      if (command === 'export') {
        const file = args[args.indexOf('--output') + 1];
        if (options.exportSize !== null) files.set(file, options.exportSize ?? 4096);
        return { code: 0, stdout: '' };
      }
      return { code: 1, stdout: '' };
    },
    prompt: async (question) => (prompts.push(question), answers.shift() ?? ''),
    fileSize: (path) => files.get(path) ?? null,
    mkdir: () => undefined,
    now: () => new Date('2026-10-08T10:00:00.000Z'),
    log: (m) => out.push(m),
    error: (m) => out.push(m),
  };
  return { deps, calls, out, prompts };
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

test('apply: mimo interaktivní terminál (CI, build) se nic nespustí', async () => {
  for (const target of ['production', 'preview'] as const) {
    const f = fake({ target, applied: LOCAL.slice(0, -1), interactive: false });
    assert.equal(await applyTarget(TARGETS[target], f.deps), 1);
    assert.deepEqual(f.calls, [], 'žádné volání wrangleru');
    assert.ok(f.out.some((l) => l.includes('nikdy v CI')));
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

test('apply produkce: nedestruktivní migrace po opsání názvu, bez zálohy', async () => {
  const f = fake({ applied: LOCAL.slice(0, -1), answers: ['chalupa-vsetice-rezervace'] });
  assert.equal(await applyTarget(TARGETS.production, f.deps), 0, f.out.join('\n'));
  assert.deepEqual(f.calls.map(commandOf), ['d1 execute', 'd1 migrations apply', 'd1 execute']);
  assert.deepEqual(f.calls[1], ['d1', 'migrations', 'apply', 'chalupa-vsetice-rezervace', '--remote', '--config', 'wrangler.jsonc']);
  assert.equal(f.prompts.length, 1);
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

test('apply produkce: destruktivní migrace bez platné zálohy nebo potvrzení se neaplikuje', async () => {
  const cases: [Parameters<typeof fake>[0], string[]][] = [
    [{ bookmark: null, answers: ['chalupa-vsetice-rezervace', DESTRUCTIVE_CONFIRMATION] }, ['d1 execute', 'd1 time-travel info']],
    [{ exportSize: null, answers: ['chalupa-vsetice-rezervace', DESTRUCTIVE_CONFIRMATION] }, ['d1 execute', 'd1 time-travel info', 'd1 export']],
    [{ exportSize: 0, answers: ['chalupa-vsetice-rezervace', DESTRUCTIVE_CONFIRMATION] }, ['d1 execute', 'd1 time-travel info', 'd1 export']],
    [{ answers: ['chalupa-vsetice-rezervace', 'ano'] }, ['d1 execute', 'd1 time-travel info', 'd1 export']],
  ];
  for (const [options, expectedCalls] of cases) {
    const f = fake({ applied: [LOCAL[0]], ...options });
    assert.equal(await applyTarget(TARGETS.production, f.deps), 1, JSON.stringify(options));
    assert.deepEqual(f.calls.map(commandOf), expectedCalls, JSON.stringify(options));
  }
});

test('apply: selhání wrangler d1 migrations apply → exit 1', async () => {
  const f = fake({ target: 'preview', applied: LOCAL.slice(0, -1), applyCode: 1 });
  assert.equal(await applyTarget(TARGETS.preview, f.deps), 1);
  assert.ok(f.out.some((l) => l.includes('skončil kódem 1')));
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
