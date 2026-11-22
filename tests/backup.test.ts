import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { backupStatus, downloadToPending, KEEP_DAILY, KEEP_MONTHLY, MAX_EXPORT_BYTES, SqlInspector, STORAGE_ALERT_BYTES, type BackupBucket, type BackupDeps } from '../worker/backup/backup.ts';
import { BACKUP_CRON, MONITOR_CRON, runDate, runMode } from '../worker/backup/workflow.ts';
import { parseJsonc } from '../scripts/lib/d1-migrations.ts';

// Automatická záloha D1 → R2 (worker/backup). Workflow běží ve workerd (Miniflare) se skutečným
// R2, DigestStream a FixedLengthStream; D1 API, podepsanou URL a Resend obsluhuje falešná služba.
// Fixture tests/fixtures/d1-export.sql je skutečný export D1 (`wrangler d1 export --local`)
// lokální databáze se všemi migracemi a syntetickými daty (rok 2030, domény .invalid).

const ROOT = new URL('..', import.meta.url).pathname;
const EXPORT = readFileSync(join(ROOT, 'tests/fixtures/d1-export.sql'));
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'test-d1-export-token-0000000000000000';
const DATABASE_ID = '00000000-0000-4000-8000-0000000000d1';
const SIGNED = 'https://signed.export.invalid/download/dump.sql?X-Amz-Signature=tajny-podpis';
const BOOKMARK = '00000503-00000000-0000512b-0011b73bb8df8447f976948c7f8b231a';
const md5 = (bytes: Uint8Array | string) => createHash('md5').update(bytes).digest('hex');

const ENV = {
  BACKUP_ENV: 'production',
  DATABASE_NAME: 'chalupa-vsetice-rezervace',
  DATABASE_ID,
  D1_EXPORT_ACCOUNT_ID: ACCOUNT,
  D1_EXPORT_API_TOKEN: TOKEN,
};

// --- Falešný Cloudflare API / podepsaná URL / Resend ------------------------------------------

type ExportReply = { status: 'pending' } | { status: 'complete' } | { status: 'error' } | { http: number } | { raw: string } | { body: unknown };
type DownloadReply = 'ok' | 'no-length' | 'truncated' | { http: number } | { body: Uint8Array | string };

let exportReplies: ExportReply[];
let downloadReplies: DownloadReply[];
let calls: { kind: 'export' | 'download' | 'resend' | 'other'; body?: Record<string, unknown>; headers?: Record<string, string>; url: string }[];

function envelope(result: Record<string, unknown>) {
  return Response.json({ success: true, errors: [], messages: [], result });
}

async function service(request: Request): Promise<Response> {
  const url = request.url;
  if (url.startsWith('https://api.cloudflare.com/')) {
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({ kind: 'export', url, body, headers: Object.fromEntries(request.headers) });
    const reply = exportReplies.shift() ?? { status: 'complete' };
    if ('http' in reply) return new Response('chyba', { status: reply.http });
    if ('raw' in reply) return new Response(reply.raw, { headers: { 'content-type': 'application/json' } });
    if ('body' in reply) return Response.json(reply.body);
    const base = { success: true, type: 'export', at_bookmark: BOOKMARK, messages: ['Generating …'] };
    if (reply.status === 'pending') return envelope(base);
    if (reply.status === 'error') return envelope({ ...base, status: 'error', error: 'internal' });
    return envelope({ ...base, status: 'complete', result: { filename: 'dump.sql', signed_url: SIGNED } });
  }
  if (url.startsWith('https://signed.export.invalid/')) {
    calls.push({ kind: 'download', url });
    const reply = downloadReplies.shift() ?? 'ok';
    if (typeof reply === 'object' && 'http' in reply) return new Response('<Error>AccessDenied</Error>', { status: reply.http });
    if (reply === 'no-length') return new Response(new Blob([EXPORT]).stream());
    if (reply === 'truncated') {
      const half = EXPORT.subarray(0, EXPORT.length / 2);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(half);
          controller.error(new Error('spojení přerušeno'));
        },
      });
      return new Response(stream, { headers: { 'content-length': String(EXPORT.length) } });
    }
    const bytes = reply === 'ok' ? EXPORT : typeof reply.body === 'string' ? new TextEncoder().encode(reply.body) : reply.body;
    return new Response(bytes as BodyInit, { headers: { 'content-length': String(bytes.length) } });
  }
  if (url === 'https://api.resend.com/emails') {
    calls.push({ kind: 'resend', url, body: (await request.json()) as Record<string, unknown>, headers: Object.fromEntries(request.headers) });
    return Response.json({ id: 'fake' });
  }
  calls.push({ kind: 'other', url });
  return new Response('neočekávaný požadavek', { status: 599 });
}

// --- Miniflare -------------------------------------------------------------------------------

let mf: Miniflare;
let bucket: R2Bucket;

before(async () => {
  // Bundle harnessu (TypeScript → JS) stejným wranglerem jako nasazení.
  const out = mkdtempSync(join(tmpdir(), 'backup-harness-'));
  const config = join(out, 'wrangler.jsonc');
  writeFileSync(config, JSON.stringify({ name: 'backup-harness', main: join(ROOT, 'tests/fixtures/backup-harness.ts'), compatibility_date: '2026-05-01' }));
  const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  const built = spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', join(out, 'dist'), '--config', config], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  mf = new Miniflare({
    modules: true,
    script: readFileSync(join(out, 'dist', 'backup-harness.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, ''),
    compatibilityDate: '2026-05-01',
    r2Buckets: ['BACKUPS'],
    outboundService: service,
  });
  bucket = (await mf.getR2Bucket('BACKUPS')) as unknown as R2Bucket;
});
after(() => mf?.dispose());

beforeEach(async () => {
  exportReplies = [];
  downloadReplies = [];
  calls = [];
  for (;;) {
    const page = await bucket.list();
    if (page.objects.length === 0) break;
    await bucket.delete(page.objects.map((o) => o.key));
  }
});

interface RunOutput {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown> & { status: Record<string, unknown>; alerts: string[] };
  steps: { name: string; attempts: number; ok: boolean }[];
  logs: string[];
}

async function run(options: { date?: string; instanceId?: string; mode?: 'backup' | 'monitor'; cron?: string; env?: Record<string, string>; now?: string } = {}): Promise<RunOutput> {
  const date = options.date ?? '2030-01-15';
  const scheduledTime = `${date}T02:15:00.000Z`;
  const response = await mf.dispatchFetch('http://harness/', {
    method: 'POST',
    body: JSON.stringify({
      event: {
        instanceId: options.instanceId ?? `instance-${date}`,
        timestamp: scheduledTime,
        ...(options.mode ? { payload: { mode: options.mode } } : { schedule: { cron: options.cron ?? '15 2 * * *', scheduledTime } }),
      },
      env: { ...ENV, ...options.env },
      now: options.now,
    }),
  });
  return (await response.json()) as RunOutput;
}

const keys = async (prefix?: string) => (await bucket.list({ prefix })).objects.map((o) => o.key).sort();
const text = async (key: string) => (await bucket.get(key))!.text();

test('záloha: export → pending → denní a měsíční snapshot; obsah, MD5 a metadata; pending smazán', async () => {
  const out = await run();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result!.daily, 'stored');
  assert.equal(out.result!.monthly, 'stored');
  assert.equal(out.result!.bytes, EXPORT.length);
  assert.deepEqual(await keys(), ['daily/2030-01-15.sql', 'monthly/2030-01.sql']);
  for (const key of ['daily/2030-01-15.sql', 'monthly/2030-01.sql']) {
    const object = (await bucket.get(key))!;
    const bytes = new Uint8Array(await object.arrayBuffer());
    assert.equal(md5(bytes), md5(EXPORT), key);
    assert.equal(object.httpMetadata?.contentType, 'application/sql');
    assert.deepEqual(object.customMetadata, { database: 'chalupa-vsetice-rezervace', environment: 'production', bookmark: BOOKMARK, createdAt: object.customMetadata!.createdAt, migrations: '10', md5: md5(EXPORT), bytes: String(EXPORT.length) });
  }
  // Export: obnovitelný formát D1, dotaz s tokenem; nikdy sqlite3_cli_only.
  const [start] = calls.filter((c) => c.kind === 'export');
  assert.equal(start.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE_ID}/export`);
  assert.deepEqual(start.body, { output_format: 'polling', dump_options: { compatibility: 'd1' } });
  assert.equal(start.headers!.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(out.result!.alerts, []);
  assert.deepEqual(out.steps.map((s) => s.name), ['kontrola dnešní zálohy', 'export D1 do pending', 'uložení denní zálohy', 'měsíční záloha', 'retence', 'kontrola objemu']);
});

test('export: dotazování probíhajícího exportu se stejným bookmarkem; omezený počet dotazů → export-timeout a opakování kroku', async () => {
  exportReplies = [{ status: 'pending' }, { status: 'pending' }, { status: 'complete' }];
  const out = await run();
  assert.equal(out.ok, true, JSON.stringify(out));
  const exports = calls.filter((c) => c.kind === 'export');
  assert.equal(exports.length, 3);
  assert.equal(exports[0].body!.current_bookmark, undefined);
  for (const poll of exports.slice(1)) assert.deepEqual(poll.body, { output_format: 'polling', dump_options: { compatibility: 'd1' }, current_bookmark: BOOKMARK });

  // Nikdy nedokončený export: MAX_POLLS (20) dotazů na pokus, 4 pokusy (retries.limit 3), pak chyba.
  calls = [];
  exportReplies = Array.from({ length: 200 }, () => ({ status: 'pending' as const }));
  const failed = await run({ date: '2030-01-16' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'export-timeout');
  assert.equal(calls.filter((c) => c.kind === 'export').length, 4 * 21);
  assert.deepEqual(failed.steps.find((s) => s.name === 'export D1 do pending'), { name: 'export D1 do pending', attempts: 4, ok: false });
  // Předchozí záloha zůstává, za neúspěšný den nic nevzniklo.
  assert.deepEqual(await keys('daily/'), ['daily/2030-01-15.sql']);
});

test('export: chyby API (HTTP, nevalidní JSON, success false, status error, chybějící/neplatná URL či bookmark) nikdy neuloží zálohu', async () => {
  const base = { success: true, type: 'export', at_bookmark: BOOKMARK, messages: [] };
  const cases: [ExportReply, string][] = [
    [{ http: 500 }, 'api-http-500'],
    [{ http: 403 }, 'api-http-403'],
    [{ raw: '<html>chyba</html>' }, 'api-invalid-response'],
    [{ body: { success: false, errors: [{ code: 7500 }], result: null } }, 'api-invalid-response'],
    [{ body: { success: true, result: { ...base, success: false } } }, 'export-failed'],
    [{ status: 'error' }, 'export-failed'],
    // HTTP 200 se stavem complete, ale bez podepsané URL.
    [{ body: { success: true, result: { ...base, status: 'complete', result: { filename: 'x.sql' } } } }, 'api-invalid-response'],
    [{ body: { success: true, result: { ...base, status: 'complete', result: { signed_url: 'http://signed.export.invalid/x' } } } }, 'api-invalid-response'],
    [{ body: { success: true, result: { ...base, at_bookmark: 'neplatny', status: 'complete', result: { signed_url: SIGNED } } } }, 'api-invalid-response'],
    [{ body: { success: true, result: { ...base, status: 'hotovo' } } }, 'api-invalid-response'],
  ];
  for (const [reply, kind] of cases) {
    calls = [];
    exportReplies = Array.from({ length: 4 }, () => reply);
    const out = await run();
    assert.equal(out.ok, false, JSON.stringify(reply));
    assert.equal(out.error, kind, JSON.stringify(reply));
    assert.equal(calls.filter((c) => c.kind === 'download').length, 0, JSON.stringify(reply));
    assert.deepEqual(await keys(), [], JSON.stringify(reply));
  }
});

test('stažení: vypršená podepsaná URL (403) → nový export v dalším pokusu; bez Content-Length nebo přerušený stream → nic se neuloží', async () => {
  downloadReplies = [{ http: 403 }, 'ok'];
  const out = await run();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls.filter((c) => c.kind === 'export').length, 2, 'nový export po vypršení URL');
  assert.deepEqual(await keys(), ['daily/2030-01-15.sql', 'monthly/2030-01.sql']);

  for (const [reply, kind] of [['no-length', 'download-no-length'], ['truncated', 'upload-failed'], [{ http: 404 }, 'download-http-404']] as [DownloadReply, string][]) {
    downloadReplies = Array.from({ length: 4 }, () => reply);
    const failed = await run({ date: '2030-01-16' });
    assert.equal(failed.ok, false, String(reply));
    assert.equal(failed.error, kind, JSON.stringify(reply));
    // Starší funkční záloha zůstává; nový neúplný soubor nevznikl ani v pending/.
    assert.deepEqual(await keys(), ['daily/2030-01-15.sql', 'monthly/2030-01.sql'], JSON.stringify(reply));
    assert.equal(md5(new Uint8Array(await (await bucket.get('daily/2030-01-15.sql'))!.arrayBuffer())), md5(EXPORT));
  }
});

test('validace obsahu: jiné prostředí, nekompletní nebo cizí soubor → invalid-export, pending smazán, nic se nepovýší', async () => {
  const sql = EXPORT.toString('utf8');
  const cases: [string | Uint8Array, string][] = [
    [sql.replace("VALUES('environment','production')", "VALUES('environment','preview')"), 'environment-mismatch'],
    [sql.slice(0, sql.lastIndexOf(';')), 'truncated'],
    [sql.replace(/CREATE TABLE reservations/, 'CREATE TABLE rezervace'), 'missing-reservationsSchema'],
    [sql.replace(/INSERT INTO "d1_migrations"/g, 'INSERT INTO "jine"'), 'missing-migration-rows'],
    ['<?xml version="1.0"?><Error>AccessDenied</Error>', 'unexpected-start'],
    [new Uint8Array([0xff, 0xfe, 0x00, 0x3b]), 'not-utf8'],
  ];
  for (const [body, problem] of cases) {
    downloadReplies = Array.from({ length: 4 }, () => ({ body }));
    const out = await run();
    assert.equal(out.ok, false, problem);
    assert.equal(out.error, 'invalid-export', problem);
    assert.ok(out.logs.some((l) => l.startsWith('d1-backup: export check failed') && l.includes(problem)), `${problem}\n${out.logs.join('\n')}`);
    assert.deepEqual(await keys(), [], problem);
  }
});

test('idempotence: stejný den → export se nespouští (žádný duplikát); existující snapshot s jiným obsahem se nepřepíše', async () => {
  assert.equal((await run()).ok, true);
  calls = [];
  const again = await run({ instanceId: 'retry-instance' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.result!.daily, 'exists');
  assert.equal(again.result!.monthly, 'exists');
  assert.equal(calls.filter((c) => c.kind === 'export').length, 0);
  // Další den s jiným obsahem DB: nový denní snapshot; měsíční (první úspěšná záloha měsíce)
  // zůstává beze změny – historické soubory se nepřepisují novějšími.
  const changed = EXPORT.toString('utf8').replace('Poznámka; se středníkem', 'Jiná poznámka; se středníkem');
  downloadReplies = [{ body: changed }];
  const next = await run({ date: '2030-01-16' });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.result!.daily, 'stored');
  assert.equal(next.result!.monthly, 'exists');
  assert.deepEqual(await keys(), ['daily/2030-01-15.sql', 'daily/2030-01-16.sql', 'monthly/2030-01.sql']);
  assert.equal(await text('daily/2030-01-16.sql'), changed);
  assert.equal(md5(new Uint8Array(await (await bucket.get('monthly/2030-01.sql'))!.arrayBuffer())), md5(EXPORT));

  // Cizí obsah pod klíčem dnešního snapshotu se nikdy nepřepíše (a export se nespouští).
  await bucket.put('daily/2030-02-01.sql', 'jiný obsah');
  await bucket.put('monthly/2030-02.sql', 'jiný obsah');
  calls = [];
  const conflict = await run({ date: '2030-02-01' });
  assert.equal(conflict.ok, true, JSON.stringify(conflict));
  assert.equal(calls.filter((c) => c.kind === 'export').length, 0);
  assert.equal(await text('daily/2030-02-01.sql'), 'jiný obsah');
  assert.equal(await text('monthly/2030-02.sql'), 'jiný obsah');
});

test('retence: po úspěchu 30 denních a 12 měsíčních nejnovějších; cizí objekty zůstávají; neúspěšný běh nic nemaže', async () => {
  const days = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2029, 11, 1 + i)).toISOString().slice(0, 10));
  const months = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2028, 10 + i, 1)).toISOString().slice(0, 7));
  for (const day of days) await bucket.put(`daily/${day}.sql`, 'starší záloha');
  for (const month of months) await bucket.put(`monthly/${month}.sql`, 'starší záloha');
  await bucket.put('daily/poznamka.txt', 'není snapshot');

  exportReplies = Array.from({ length: 4 }, () => ({ http: 500 }));
  const failed = await run({ date: '2030-01-15' });
  assert.equal(failed.ok, false);
  assert.equal((await keys('daily/')).length, 36, 'neúspěšný běh nic nemaže');
  assert.equal((await keys('monthly/')).length, 14);

  const out = await run({ date: '2030-01-15' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const daily = await keys('daily/');
  assert.equal(daily.filter((k) => k.endsWith('.sql')).length, 30);
  assert.ok(daily.includes('daily/2030-01-15.sql') && daily.includes('daily/poznamka.txt'));
  // 36 snapshotů (2029-12-01 … 2030-01-04 + 2030-01-15) → 30 nejnovějších, nejstarší ponechaný 2029-12-07.
  assert.equal(daily.filter((k) => k.endsWith('.sql'))[0], 'daily/2029-12-07.sql', 'nejstarší ponechaný');
  const monthly = await keys('monthly/');
  assert.equal(monthly.length, 12);
  assert.equal(monthly.at(-1), 'monthly/2030-01.sql');
  assert.equal(out.result!.pruned, 6 + 3);
});

test('pending: pozůstatky neúspěšných běhů starší než 24 h smaže úspěšná záloha', async () => {
  await bucket.put('pending/stary-beh.sql', 'neúplný');
  const now = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const out = await run({ now });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(await keys('pending/'), []);
});

test('kontrola (14:45 UTC): žádná nebo stará denní záloha → upozornění; čerstvá → nic; bez Resend jen log', async () => {
  const resend = { RESEND_API_KEY: 're_test_FAKE', CONFLICT_ALERT_EMAIL: 'spravce@example.invalid', CONFLICT_ALERT_FROM: 'Chalupa Všetice <rezervace@example.invalid>' };
  const empty = await run({ cron: '45 14 * * *', env: resend });
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.deepEqual(empty.result!.alerts, ['backup-stale']);
  assert.equal(calls.filter((c) => c.kind === 'export').length, 0, 'kontrola nic neexportuje');
  const [mail] = calls.filter((c) => c.kind === 'resend');
  assert.equal(mail.body!.to?.toString(), 'spravce@example.invalid');
  assert.match(String(mail.body!.subject), /^POZOR: záloha D1 chalupa-vsetice-rezervace – backup-stale$/);
  assert.equal(mail.headers!['idempotency-key'], 'd1-backup-production-backup-stale-2030-01-15');

  assert.equal((await run()).ok, true);
  calls = [];
  const fresh = await run({ cron: '45 14 * * *', env: resend });
  assert.deepEqual(fresh.result!.alerts, []);
  assert.equal(calls.filter((c) => c.kind === 'resend').length, 0);
  const late = await run({ cron: '45 14 * * *', env: resend, now: new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString() });
  assert.deepEqual(late.result!.alerts, ['backup-stale']);

  const unconfigured = await run({ mode: 'monitor', now: new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString() });
  assert.deepEqual(unconfigured.result!.alerts, ['backup-stale']);
  assert.ok(unconfigured.logs.includes('d1-backup: alert skipped (not configured)'));
});

test('selhání zálohy → upozornění bez osobních údajů, tokenu a podepsané URL; logy jen druh chyby', async () => {
  const resend = { RESEND_API_KEY: 're_test_FAKE', CONFLICT_ALERT_EMAIL: 'spravce@example.invalid' };
  downloadReplies = Array.from({ length: 4 }, () => ({ body: EXPORT.toString('utf8').replace("'production'", "'preview'") }));
  const out = await run({ env: resend });
  assert.equal(out.ok, false);
  const [mail] = calls.filter((c) => c.kind === 'resend');
  assert.match(String(mail.body!.subject), /backup-failed$/);
  const body = JSON.stringify(mail.body);
  assert.match(body, /invalid-export/);
  assert.match(body, /Starší zálohy zůstávají beze změny/);
  for (const secret of [TOKEN, 'X-Amz-Signature', 'tajny-podpis', 'signed.export', 'host-zaloha', 'Zálohový', '+420', ACCOUNT, BOOKMARK]) {
    assert.ok(!body.includes(secret), `e-mail: ${secret}`);
    assert.ok(!out.logs.join('\n').includes(secret), `log: ${secret}`);
  }
  // Ani výsledek úspěšného běhu (stav Workflow) neobsahuje URL ani token.
  const ok = await run({ date: '2030-01-16' });
  const state = JSON.stringify(ok);
  for (const secret of [TOKEN, 'X-Amz-Signature', 'signed.export', 'host-zaloha']) assert.ok(!state.includes(secret), `stav: ${secret}`);
});

test('chybějící konfigurace (token, účet) → not-configured bez volání API', async () => {
  const out = await run({ env: { D1_EXPORT_API_TOKEN: '' } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not-configured');
  assert.equal(calls.filter((c) => c.kind === 'export').length, 0);
});

/** Příkazy SQL exportu (středník mimo řetězec na konci řádku) – jako `wrangler d1 execute --file`. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    current += c;
    if (c === "'") quoted = !quoted;
    else if (c === ';' && !quoted && (sql[i + 1] === '\n' || i + 1 === sql.length)) {
      out.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

test('obnova: snapshot z R2 jde importovat do samostatné prázdné D1; data, migrace i prostředí odpovídají', async () => {
  assert.equal((await run()).ok, true);
  const snapshot = await text('daily/2030-01-15.sql');
  const restore = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-05-01', d1Databases: { DB: 'restore-test' } });
  try {
    const db = (await restore.getD1Database('DB')) as unknown as D1Database;
    for (const statement of statements(snapshot).filter((st) => !st.startsWith('PRAGMA'))) await db.prepare(statement).run();
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
    assert.equal(await count('SELECT count(*) AS n FROM reservations'), 2);
    assert.equal(await count('SELECT count(*) AS n FROM d1_migrations'), 10);
    assert.equal((await db.prepare("SELECT value FROM meta WHERE key = 'environment'").first<{ value: string }>())!.value, 'production');
    const row = (await db.prepare("SELECT note, status, locale FROM reservations WHERE public_code = '10013001'").first<{ note: string; status: string; locale: string }>())!;
    assert.deepEqual(row, { note: "Poznámka; se středníkem a apostrofem ' uvnitř", status: 'pending_payment', locale: 'cs' });
    // Obnovená databáze má funkční triggery (zrušení uvolní noci a zvýší sekvenci).
    await db.prepare("UPDATE reservations SET status = 'cancelled' WHERE public_code = '10013002'").run();
    assert.equal((await db.prepare("SELECT ical_sequence AS n FROM reservations WHERE public_code = '10013002'").first<{ n: number }>())!.n, 1);
  } finally {
    await restore.dispose();
  }
});

test('SqlInspector: výsledek nezávisí na dělení streamu (i po 1 bajtu, přes vícebajtové znaky)', () => {
  const whole = new SqlInspector('production');
  whole.push(EXPORT);
  whole.finish();
  assert.deepEqual(whole.problems(), []);
  assert.equal(whole.migrations, 10);
  for (const size of [1, 7, 64, 255, 1000]) {
    const inspector = new SqlInspector('production');
    for (let i = 0; i < EXPORT.length; i += size) inspector.push(EXPORT.subarray(i, i + size));
    inspector.finish();
    assert.deepEqual(inspector.problems(), [], String(size));
    assert.equal(inspector.migrations, 10, String(size));
  }
  const wrong = new SqlInspector('preview');
  wrong.push(EXPORT);
  wrong.finish();
  assert.deepEqual(wrong.problems(), ['environment-mismatch']);
});

test('backupStatus: objem nad 7 GB → upozornění; stáří poslední denní zálohy; jen snapshoty se počítají jako zálohy', async () => {
  const now = new Date('2030-01-15T14:45:00Z');
  const object = (key: string, size: number, uploaded: string) => ({ key, size, uploaded: new Date(uploaded) }) as R2Object;
  const fake = (objects: R2Object[]): BackupBucket => ({ list: async () => ({ objects, truncated: false, delimitedPrefixes: [] }) }) as unknown as BackupBucket;
  const ok = await backupStatus(fake([object('daily/2030-01-15.sql', 6_000, '2030-01-15T02:16:00Z'), object('monthly/2030-01.sql', 6_000, '2030-01-01T02:16:00Z')]), now);
  assert.deepEqual({ stale: ok.stale, nearLimit: ok.nearLimit, dailyCount: ok.dailyCount, monthlyCount: ok.monthlyCount, totalBytes: ok.totalBytes }, { stale: false, nearLimit: false, dailyCount: 1, monthlyCount: 1, totalBytes: 12_000 });
  const big = await backupStatus(fake([object('daily/2030-01-15.sql', STORAGE_ALERT_BYTES, '2030-01-15T02:16:00Z'), object('pending/x.sql', 1, '2030-01-15T02:16:00Z')]), now);
  assert.equal(big.nearLimit, true);
  const old = await backupStatus(fake([object('daily/2030-01-13.sql', 6_000, '2030-01-13T02:16:00Z'), object('daily/poznamka.sql', 1, '2030-01-15T10:00:00Z')]), now);
  assert.equal(old.stale, true);
  assert.equal(old.latest!.key, 'daily/2030-01-13.sql');
  assert.equal((await backupStatus(fake([]), now)).stale, true);
});

test('rozvrh: 02:15 UTC záloha, 14:45 UTC kontrola; ruční spuštění podle payloadu; datum z plánovaného času', () => {
  const at = new Date('2030-01-15T23:59:00Z');
  assert.equal(runMode({ instanceId: 'a', timestamp: at, schedule: { cron: BACKUP_CRON, scheduledTime: Date.parse('2030-01-15T02:15:00Z') } }), 'backup');
  assert.equal(runMode({ instanceId: 'a', timestamp: at, schedule: { cron: MONITOR_CRON, scheduledTime: Date.parse('2030-01-15T14:45:00Z') } }), 'monitor');
  assert.equal(runMode({ instanceId: 'a', timestamp: at, payload: { mode: 'monitor' } }), 'monitor');
  assert.equal(runMode({ instanceId: 'a', timestamp: at }), 'backup');
  assert.equal(runDate({ instanceId: 'a', timestamp: new Date('2030-01-16T00:01:00Z'), schedule: { cron: BACKUP_CRON, scheduledTime: Date.parse('2030-01-15T02:15:00Z') } }), '2030-01-15');
  assert.equal(runDate({ instanceId: 'a', timestamp: at }), '2030-01-15');
});

test('wrangler.backup.jsonc: samostatný Worker bez veřejné URL a sdílených bindingů; rozvrh přes workflows[].schedules', () => {
  type Cfg = Record<string, any>;
  const backup = parseJsonc(readFileSync(join(ROOT, 'wrangler.backup.jsonc'), 'utf8')) as Cfg;
  const main = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')) as Cfg;
  const previewMigrations = parseJsonc(readFileSync(join(ROOT, 'wrangler.preview-migrations.jsonc'), 'utf8')) as Cfg;
  assert.equal(backup.name, 'chalupa-vsetice-d1-backup');
  assert.notEqual(backup.name, main.name);
  assert.equal(backup.main, './worker/backup/index.ts');
  assert.equal(backup.workers_dev, false);
  assert.equal(backup.preview_urls, false);
  assert.equal(backup.routes, undefined);
  assert.equal(backup.triggers, undefined, 'žádný samostatný cron handler');
  assert.equal(backup.observability.traces.enabled, false);
  assert.equal(backup.observability.logs.invocation_logs, false);
  assert.equal(backup.d1_databases, undefined, 'záloha přes REST API, bez D1 bindingu');
  assert.deepEqual(backup.workflows, [{ name: 'chalupa-vsetice-d1-backup', binding: 'BACKUP_WORKFLOW', class_name: 'D1BackupWorkflow', schedules: [BACKUP_CRON, MONITOR_CRON] }]);
  assert.deepEqual(backup.r2_buckets, [{ binding: 'BACKUPS', bucket_name: 'chalupa-vsetice-d1-backups' }]);
  const prodDb = main.d1_databases.find((d: Cfg) => d.binding === 'DB');
  assert.deepEqual(backup.vars, { BACKUP_ENV: 'production', DATABASE_NAME: prodDb.database_name, DATABASE_ID: prodDb.database_id });
  // Test: testovací D1 → testovací bucket, bez rozvrhu.
  const testEnv = backup.env.test;
  assert.equal(testEnv.name, 'chalupa-vsetice-d1-backup-test');
  assert.deepEqual(testEnv.vars, { BACKUP_ENV: 'preview', DATABASE_NAME: previewMigrations.d1_databases[0].database_name, DATABASE_ID: previewMigrations.d1_databases[0].database_id });
  assert.equal(testEnv.workflows[0].schedules, undefined);
  assert.equal(testEnv.workflows[0].name, 'chalupa-vsetice-d1-backup-test');
  assert.deepEqual(testEnv.r2_buckets, [{ binding: 'BACKUPS', bucket_name: 'chalupa-vsetice-d1-backups-test' }]);
  // Žádné secrets v konfiguraci; rezervační Worker zálohy nezná.
  const text = readFileSync(join(ROOT, 'wrangler.backup.jsonc'), 'utf8');
  for (const name of ['D1_EXPORT_API_TOKEN', 'D1_EXPORT_ACCOUNT_ID', 'RESEND_API_KEY']) assert.ok(!(name in backup.vars) && !(name in testEnv.vars), name);
  assert.ok(!/[0-9a-f]{32}/.test(text.replace(/"database_id"|DATABASE_ID": "[^"]+"/g, '')), 'žádné ID účtu');
  assert.ok(!JSON.stringify(main).includes('backup') && main.workflows === undefined);
  // Workers Builds rezervačního Workeru (deploy, deploy:preview) zálohovací Worker nenasazuje.
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  for (const name of ['build', 'deploy', 'deploy:preview']) assert.ok(!scripts[name].includes('wrangler.backup.jsonc'), name);
  assert.equal(scripts['backup:deploy'], 'wrangler deploy --config wrangler.backup.jsonc --env=');
  assert.equal(scripts['backup:deploy:test'], 'wrangler deploy --config wrangler.backup.jsonc --env test');
});

test('náklady: strop velikosti exportu drží nejhorší objem záloh pod bezplatnými 10 GB; větší export se neuloží', async () => {
  // 30 denních + 12 měsíčních + 1 měsíční před retencí + 1 pending.
  assert.ok((KEEP_DAILY + KEEP_MONTHLY + 2) * MAX_EXPORT_BYTES < 10 * 1000 ** 3);
  assert.ok(STORAGE_ALERT_BYTES < 10 * 1000 ** 3);
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  const deps = {
    fetch: async () => new Response(body, { headers: { 'content-length': String(MAX_EXPORT_BYTES + 1) } }),
    bucket: { put: async () => assert.fail('nic se nesmí ukládat') },
  } as unknown as BackupDeps;
  await assert.rejects(downloadToPending({ accountId: 'a', databaseId: 'd', databaseName: 'n', environment: 'production', apiToken: 't' }, deps, SIGNED, 'pending/x.sql'), (error: { kind?: string }) => error.kind === 'export-too-large');
  assert.equal(cancelled, true, 'stahování se ukončí');
});
