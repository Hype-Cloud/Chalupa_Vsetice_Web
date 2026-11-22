import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { Miniflare } from 'miniflare';
import { sha256Hex } from '../lib/backup/core.ts';
import { GithubClient, identifySnapshot, publishSnapshot, RELEASE_MARKER, releaseTag, type GithubDeps } from '../lib/backup/github.ts';
import { runGithubBackup, runGithubMonitor } from '../lib/backup/github-run.ts';
import { buildManifest, type SnapshotManifest, type SnapshotRef } from '../lib/backup/snapshot.ts';
import { expectedRowCounts, runCli, sqlStatements, type CliDeps } from '../scripts/lib/backup-cli.ts';
import { FakeGithub } from './fixtures/fake-github.ts';

// Backend GitHub Releases: běh zálohy (export → gzip → age → draft → upload → ověření →
// publikace), idempotence a souběh, retence, monitor, CLI (stažení, ověření, rozšifrování)
// a integrační obnova do skutečné (lokální, workerd) D1. GitHub, D1 API a Resend jsou falešné;
// data jsou syntetická (fixture d1-export.sql), klíče age generované v testu.

const ROOT = new URL('..', import.meta.url).pathname;
const EXPORT = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/d1-export.sql')));
const BOOKMARK = '00000503-00000000-0000512b-0011b73bb8df8447f976948c7f8b231a';
const SIGNED = 'https://signed.export.invalid/download/dump.sql?X-Amz-Signature=tajny-podpis';
const D1_TOKEN = 'test-d1-export-token-0000000000000000';
const GH_TOKEN = 'ghs_testtoken000000000000000000000000';
const GH_READ_TOKEN = 'github_pat_readonly_test_000000000000';
const OWNER = 'example-owner';
const REPO = 'd1-backups';
const DB = 'chalupa-vsetice-rezervace';

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);

const ENV: Record<string, string> = {
  BACKUP_BACKEND: 'github',
  BACKUP_ENV: 'production',
  BACKUP_DATABASE_NAME: DB,
  BACKUP_DATABASE_ID: '00000000-0000-4000-8000-0000000000d1',
  BACKUP_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  BACKUP_GITHUB_REPO: `${OWNER}/${REPO}`,
  BACKUP_AGE_RECIPIENT: recipient,
  BACKUP_GITHUB_TOKEN: GH_TOKEN,
  D1_EXPORT_API_TOKEN: D1_TOKEN,
  RESEND_API_KEY: 're_test_FAKE',
  CONFLICT_ALERT_EMAIL: 'spravce@example.invalid',
};

let github: FakeGithub;
let now: Date;
let logs: string[];
let mails: { subject: string; text: string }[];
let exportCalls: number;
let exportBody: Uint8Array;

beforeEach(() => {
  now = new Date('2030-01-15T02:17:00Z');
  github = new FakeGithub({ owner: OWNER, repo: REPO, token: GH_TOKEN, readOnlyTokens: [GH_READ_TOKEN] });
  github.now = () => now;
  logs = [];
  mails = [];
  exportCalls = 0;
  exportBody = EXPORT;
});

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.url.startsWith('https://api.cloudflare.com/')) {
    exportCalls++;
    assert.equal(request.headers.get('authorization'), `Bearer ${D1_TOKEN}`);
    return Response.json({ success: true, errors: [], messages: [], result: { success: true, type: 'export', at_bookmark: BOOKMARK, status: 'complete', result: { filename: 'dump.sql', signed_url: SIGNED } } });
  }
  if (request.url.startsWith('https://signed.export.invalid/')) return new Response(exportBody as BodyInit, { headers: { 'content-length': String(exportBody.length) } });
  if (request.url === 'https://api.resend.com/emails') {
    const body = (await request.json()) as { subject: string; text: string };
    mails.push({ subject: body.subject, text: body.text });
    return Response.json({ id: 'fake' });
  }
  return github.fetch(request);
}

const deps = (): GithubDeps => ({ fetch: route, sleep: async () => undefined, log: (m) => logs.push(m), now: () => now });
const target = { owner: OWNER, repo: REPO, database: DB, environment: 'production' };
const client = (token = GH_TOKEN) => new GithubClient(target, token, deps());

function ours(type: 'daily' | 'monthly' = 'daily') {
  return github.releases.filter((r) => !r.draft && identifySnapshot(target, r) && r.tag_name.includes(`--${type}--`));
}

async function manifestOf(tag: string): Promise<SnapshotManifest> {
  const release = github.releases.find((r) => r.tag_name === tag && !r.draft)!;
  const asset = release.assets.find((a) => a.name.endsWith('.manifest.json'))!;
  return JSON.parse(new TextDecoder().decode(asset.bytes)) as SnapshotManifest;
}

// --- Běh zálohy -------------------------------------------------------------------------------------

test('záloha: denní i měsíční snapshot jako šifrované assety releasu; manifest; žádný e-mail při úspěchu', async () => {
  const result = await runGithubBackup(ENV, deps());
  assert.equal(result.daily, 'stored');
  assert.equal(result.monthly, 'stored');
  assert.deepEqual(result.alerts, []);
  assert.equal(mails.length, 0);
  const daily = github.releases.find((r) => r.tag_name === `d1backup--production--${DB}--daily--2030-01-15`)!;
  assert.equal(daily.draft, false);
  assert.ok(daily.body.includes(RELEASE_MARKER));
  assert.deepEqual(daily.assets.map((a) => a.name).sort(), [`${DB}-production-daily-2030-01-15.manifest.json`, `${DB}-production-daily-2030-01-15.sql.gz.age`]);
  const file = daily.assets.find((a) => a.name.endsWith('.age'))!;
  assert.ok(new TextDecoder().decode(file.bytes.subarray(0, 22)).startsWith('age-encryption.org/v1'));
  assert.ok(!Buffer.from(file.bytes).includes('INSERT INTO'), 'v GitHubu nikdy nešifrované SQL');
  const manifest = await manifestOf(daily.tag_name);
  assert.equal(manifest.database, DB);
  assert.equal(manifest.environment, 'production');
  assert.equal(manifest.snapshot.id, 'daily/2030-01-15');
  assert.equal(manifest.bookmark, BOOKMARK);
  assert.equal(manifest.migrations, 10);
  assert.equal(manifest.sql.bytes, EXPORT.length);
  assert.equal(manifest.sql.sha256, await sha256Hex(EXPORT));
  assert.equal(manifest.file.sha256, await sha256Hex(file.bytes));
  assert.deepEqual([manifest.file.compression, manifest.file.encryption, manifest.file.recipients], ['gzip', 'age', [recipient]]);
  // Měsíční = stejný ověřený soubor (bez nového exportu).
  const monthly = await manifestOf(`d1backup--production--${DB}--monthly--2030-01`);
  assert.equal(monthly.file.sha256, manifest.file.sha256);
  assert.equal(monthly.file.name, `${DB}-production-monthly-2030-01.sql.gz.age`);
  assert.equal(exportCalls, 1);
  // Žádné drafty ani tag „latest“ aplikace se nemění.
  assert.equal(github.releases.filter((r) => r.draft).length, 0);
});

test('idempotence: opakovaný běh téhož dne → exists/kept bez exportu; další den → nový denní, měsíční zůstává', async () => {
  await runGithubBackup(ENV, deps());
  const again = await runGithubBackup(ENV, deps());
  assert.deepEqual([again.daily, again.monthly], ['exists', 'kept']);
  assert.equal(exportCalls, 1);
  now = new Date('2030-01-16T02:17:00Z');
  exportBody = new TextEncoder().encode(new TextDecoder().decode(EXPORT).replace('2026-11-22 21:17:22', '2026-11-22 21:17:23'));
  const next = await runGithubBackup(ENV, deps());
  assert.deepEqual([next.daily, next.monthly], ['stored', 'kept']);
  assert.equal(ours('daily').length, 2);
  assert.equal(ours('monthly').length, 1);
});

async function sealedFor(ref: SnapshotRef, content: string) {
  const bytes = new TextEncoder().encode(content);
  const manifest = buildManifest({
    database: DB,
    environment: 'production',
    snapshot: ref,
    exportedAt: now.toISOString(),
    bookmark: BOOKMARK,
    migrations: 10,
    sql: { bytes: bytes.length, sha256: await sha256Hex(bytes) },
    file: { name: `${DB}-production-${ref.type}-${ref.date}.sql.gz`, bytes: bytes.length, sha256: await sha256Hex(bytes), compression: 'gzip', encryption: 'none', recipients: [] },
  });
  return { bytes, manifest };
}

test('nepřepisování: jiný obsah existujícího denního snapshotu → snapshot-conflict, uložený obsah beze změny', async () => {
  const ref = { type: 'daily' as const, date: '2030-01-15' };
  const first = await sealedFor(ref, 'obsah A');
  assert.equal(await publishSnapshot(client(), ref, first.bytes, first.manifest, 'verify'), 'stored');
  assert.equal(await publishSnapshot(client(), ref, first.bytes, first.manifest, 'verify'), 'exists');
  const second = await sealedFor(ref, 'obsah B');
  await assert.rejects(publishSnapshot(client(), ref, second.bytes, second.manifest, 'verify'), { kind: 'snapshot-conflict' });
  assert.equal(await publishSnapshot(client(), ref, second.bytes, second.manifest, 'keep'), 'kept');
  assert.equal((await manifestOf(releaseTag(target, ref))).file.sha256, first.manifest.file.sha256);
  assert.equal(github.releases.length, 1);
});

test('souběh: dvě současné publikace stejného snapshotu → právě jedna uložena, druhá konflikt (jiný obsah) nebo exists (stejný); žádné drafty (opakováno)', async () => {
  for (let round = 0; round < 10; round++) {
    const ref = { type: 'daily' as const, date: `2030-02-${String(round + 1).padStart(2, '0')}` };
    const a = await sealedFor(ref, `A${round}`);
    const b = await sealedFor(ref, round % 2 ? `A${round}` : `B${round}`);
    github.publishBarrier = { count: 2, waiting: [] };
    const results = await Promise.allSettled([publishSnapshot(client(), ref, a.bytes, a.manifest, 'verify'), publishSnapshot(client(), ref, b.bytes, b.manifest, 'verify')]);
    github.publishBarrier = null;
    const states = results.map((r) => (r.status === 'fulfilled' ? r.value : (r.reason as { kind: string }).kind)).sort();
    assert.deepEqual(states, round % 2 ? ['exists', 'stored'] : ['snapshot-conflict', 'stored'], `kolo ${round}`);
    const published = github.releases.filter((r) => r.tag_name === releaseTag(target, ref));
    assert.equal(published.length, 1, 'jediný release, žádný draft');
    assert.equal(published[0].draft, false);
    const winner = results.findIndex((r) => r.status === 'fulfilled' && r.value === 'stored');
    assert.equal((await manifestOf(published[0].tag_name)).file.sha256, [a, b][winner].manifest.file.sha256, 'uložený obsah patří vítězi');
  }
});

test('selhání uploadu: draft se smaže, nic se nepublikuje ani nemaže, upozornění bez citlivých údajů', async () => {
  github.seed(await seededSnapshot('daily', '2030-01-14'));
  github.failUpload.set(`${DB}-production-daily-2030-01-15.sql.gz.age`, 502);
  await assert.rejects(runGithubBackup(ENV, deps()), { kind: 'upload-failed' });
  assert.equal(github.releases.length, 1, 'jen původní snapshot');
  assert.equal(github.releases.filter((r) => r.draft).length, 0);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /POZOR: záloha D1 chalupa-vsetice-rezervace – backup-failed/);
  assert.ok(mails[0].text.includes('Úložiště: GitHub Releases') && mails[0].text.includes('Doporučená akce:') && mails[0].text.includes('upload-failed'));
  assertNoSecrets([...logs, ...mails.map((m) => m.subject + m.text)].join('\n'));
});

test('ověření uploadu: poškozený uložený obsah → upload-verify-failed, draft smazán, nic nepublikováno', async () => {
  github.corruptDownloads = true;
  await assert.rejects(runGithubBackup(ENV, deps()), { kind: 'upload-verify-failed' });
  assert.equal(github.releases.length, 0);
});

test('soukromý repozitář je povinný: veřejný → odmítnuto před exportem', async () => {
  github = new FakeGithub({ owner: OWNER, repo: REPO, token: GH_TOKEN, private: false });
  await assert.rejects(runGithubBackup(ENV, deps()), { kind: 'repository-not-private' });
  assert.equal(exportCalls, 0);
  assert.equal(github.releases.length, 0);
});

test('konfigurace: chybějící šifrovací klíč v produkci → nic se neexportuje ani nenahraje', async () => {
  await assert.rejects(runGithubBackup({ ...ENV, BACKUP_AGE_RECIPIENT: '' }, deps()), { kind: 'not-configured' });
  assert.equal(exportCalls, 0);
  assert.equal(github.releases.length, 0);
  assert.equal(mails.length, 1, 'upozornění na chybnou konfiguraci');
  assert.ok(!logs.join('\n').includes(GH_TOKEN));
});

test('upozornění: produkce bez Resend konfigurace → záloha uložena, běh skončí alerts-not-configured', async () => {
  await assert.rejects(runGithubBackup({ ...ENV, RESEND_API_KEY: '', CONFLICT_ALERT_EMAIL: '' }, deps()), { kind: 'alerts-not-configured' });
  assert.equal(ours('daily').length, 1);
});

// --- Retence ------------------------------------------------------------------------------------------

async function seededSnapshot(type: 'daily' | 'monthly', date: string, options: { database?: string; environment?: string; marker?: boolean } = {}) {
  const database = options.database ?? DB;
  const environment = options.environment ?? 'production';
  const base = `${database}-${environment}-${type}-${date}`;
  const bytes = new TextEncoder().encode(`snapshot ${base}`);
  return {
    tag_name: `d1backup--${environment}--${database}--${type}--${date}`,
    body: options.marker === false ? 'ruční release' : RELEASE_MARKER,
    published_at: `${date.length === 7 ? `${date}-01` : date}T02:20:00Z`,
    assets: [
      { name: `${base}.sql.gz.age`, bytes },
      { name: `${base}.manifest.json`, bytes: new TextEncoder().encode('{}') },
    ],
  };
}

test('retence: po úspěšné záloze ponechá 30 denních a 12 měsíčních; cizí releasy a tagy nikdy nemaže', async () => {
  for (let day = 1; day <= 14; day++) github.seed(await seededSnapshot('daily', `2030-01-${String(day).padStart(2, '0')}`));
  for (let day = 1; day <= 31; day++) github.seed(await seededSnapshot('daily', `2029-12-${String(day).padStart(2, '0')}`));
  for (let month = 1; month <= 12; month++) github.seed(await seededSnapshot('monthly', `2029-${String(month).padStart(2, '0')}`));
  const foreign = [
    github.seed({ tag_name: 'v1.0.0', body: 'release aplikace' }),
    github.seed(await seededSnapshot('daily', '2020-01-01', { environment: 'preview' })),
    github.seed(await seededSnapshot('daily', '2020-01-01', { database: 'jina-databaze' })),
    github.seed(await seededSnapshot('daily', '2020-01-02', { marker: false })),
    github.seed({ ...(await seededSnapshot('daily', '2020-01-03')), assets: [] }),
  ];
  const oldDraft = github.seed({ ...(await seededSnapshot('daily', '2020-01-04')), draft: true, created_at: '2030-01-13T00:00:00Z' });
  const freshDraft = github.seed({ ...(await seededSnapshot('daily', '2020-01-05')), draft: true, created_at: '2030-01-15T01:00:00Z' });
  const result = await runGithubBackup(ENV, deps());
  assert.equal(result.daily, 'stored');
  const daily = ours('daily').map((r) => r.tag_name.slice(-10)).sort();
  assert.equal(daily.length, 30);
  assert.equal(daily[0], '2029-12-17');
  assert.equal(ours('monthly').length, 12, '13 měsíčních → nejstarší (2029-01) smazán');
  assert.ok(!github.releases.some((r) => r.tag_name.endsWith('monthly--2029-01')));
  assert.ok(!github.tags.has(`d1backup--production--${DB}--daily--2029-12-16`), 'tag smazaného snapshotu');
  for (const release of foreign) assert.ok(github.releases.includes(release), release.tag_name);
  assert.ok(!github.releases.includes(oldDraft), 'vlastní draft starší než 24 h uklizen');
  assert.ok(github.releases.includes(freshDraft), 'čerstvý draft (souběžný běh) ponechán');
  assert.equal(result.pruned, 17, '16 denních + 1 měsíční');
});

test('retence: chyba výpisu → nic se nesmaže; záloha zůstává, běh skončí retention-failed s upozorněním', async () => {
  for (let day = 1; day <= 31; day++) github.seed(await seededSnapshot('daily', `2029-12-${String(day).padStart(2, '0')}`));
  for (let i = 0; i < 100; i++) github.seed({ tag_name: `jiny-${i}` });
  github.failListPage = 2;
  const before = github.releases.length;
  await assert.rejects(runGithubBackup(ENV, deps()), { kind: 'retention-failed' });
  assert.equal(github.releases.length, before + 2, 'nový denní + měsíční, nic smazáno');
  assert.ok(mails.some((m) => m.subject.includes('retention-failed')));
});

test('neúspěšný běh nic nemaže (chyba exportu)', async () => {
  for (let day = 1; day <= 31; day++) github.seed(await seededSnapshot('daily', `2029-12-${String(day).padStart(2, '0')}`));
  exportBody = new TextEncoder().encode('neplatný export');
  await assert.rejects(runGithubBackup(ENV, deps()), { kind: 'invalid-export' });
  assert.equal(github.releases.length, 31);
});

// --- Monitor -----------------------------------------------------------------------------------------

test('monitor: token jen pro čtení; záloha > 48 h nebo žádná → upozornění; čerstvá → nic', async () => {
  const env = { ...ENV, BACKUP_GITHUB_TOKEN: GH_READ_TOKEN, D1_EXPORT_API_TOKEN: '', BACKUP_DATABASE_ID: '', BACKUP_CLOUDFLARE_ACCOUNT_ID: '', BACKUP_AGE_RECIPIENT: '' };
  const empty = await runGithubMonitor(env, deps());
  assert.equal(empty.status?.stale, true);
  assert.deepEqual(empty.alerts, ['backup-stale']);
  github.seed(await seededSnapshot('daily', '2030-01-14'));
  mails = [];
  const fresh = await runGithubMonitor(env, deps());
  assert.equal(fresh.status?.stale, false);
  assert.deepEqual(fresh.alerts, []);
  now = new Date('2030-01-16T03:00:00Z');
  const stale = await runGithubMonitor(env, deps());
  assert.deepEqual(stale.alerts, ['backup-stale']);
  assert.ok(mails[0].text.includes('Poslední denní záloha: daily/2030-01-14') && mails[0].text.includes('Doporučená akce:'));
  assert.ok(!github.requests.some((r) => r.method !== 'GET'), 'monitor jen čte');
});

test('monitor: nedostupný GitHub nebo neplatný token → monitor-failed upozornění', async () => {
  await assert.rejects(runGithubMonitor({ ...ENV, BACKUP_GITHUB_TOKEN: 'spatny-token' }, deps()), { kind: 'github-auth' });
  assert.ok(mails.some((m) => m.subject.includes('monitor-failed')));
  assertNoSecrets(mails.map((m) => m.text).join('\n') + logs.join('\n'));
});

function assertNoSecrets(text: string) {
  for (const secret of [D1_TOKEN, GH_TOKEN, GH_READ_TOKEN, 'X-Amz-Signature', 'signed.export', identity, '@example.invalid', 'INSERT INTO', 'host-zaloha']) {
    assert.ok(!text.includes(secret), `obsahuje ${secret}`);
  }
}

// --- CLI a integrační obnova ---------------------------------------------------------------------------

function cli(dir: string, d1?: D1Database, existing: string[] = []): CliDeps & { output: string[]; wranglerCalls: string[][] } {
  const output: string[] = [];
  const wranglerCalls: string[][] = [];
  return {
    ...deps(),
    env: { ...ENV, BACKUP_GITHUB_TOKEN: GH_READ_TOKEN },
    out: (m) => output.push(m),
    output,
    wranglerCalls,
    repoRoot: ROOT,
    home: dir,
    tmpdir: dir,
    isIgnored: (path) => path.includes('/.d1-backups/'),
    prompt: null,
    // Falešný wrangler: d1 list / create / execute nad lokální workerd D1 (Miniflare).
    wrangler: async (args, options) => {
      wranglerCalls.push(args);
      assert.ok(!existsSync(join(options.cwd, 'wrangler.jsonc')), 'wrangler běží mimo projekt');
      if (args[0] === 'd1' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(existing.map((name) => ({ name }))) };
      if (args[0] === 'd1' && args[1] === 'create') return { code: 0, stdout: 'created' };
      if (args[0] === 'd1' && args[1] === 'execute' && d1) {
        const file = args.find((a) => a.startsWith('--file='))?.slice(7);
        if (file) {
          for (const statement of sqlStatements(readFileSync(file, 'utf8')).filter((s) => !s.startsWith('PRAGMA'))) await d1.prepare(statement).run();
          return { code: 0, stdout: '' };
        }
        const command = args.find((a) => a.startsWith('--command='))!.slice(10);
        const { results } = await d1.prepare(command).all();
        return { code: 0, stdout: JSON.stringify([{ results, success: true }]) };
      }
      return { code: 1, stdout: '' };
    },
  };
}

test('CLI: list, download latest (ověřený, mimo repozitář), verify, decrypt; nepřepisuje bez --force; poškozený soubor odmítne', async () => {
  await runGithubBackup(ENV, deps());
  const dir = mkdtempSync(join(tmpdir(), 'backup-cli-'));
  try {
    const d = cli(dir);
    assert.equal(await runCli(['list', '--backend', 'github'], d), 0);
    assert.ok(d.output.some((l) => l.includes('daily/2030-01-15') && l.includes('šifrováno')));
    assert.ok(d.output.at(-1)?.includes('daily/2030-01-15'));

    assert.equal(await runCli(['download', '--backend', 'github', '--snapshot', 'latest'], d), 0);
    const out = join(dir, 'd1-backups', `${DB}-production`);
    const file = join(out, `${DB}-production-daily-2030-01-15.sql.gz.age`);
    assert.deepEqual(readdirSync(out).sort(), [`${DB}-production-daily-2030-01-15.manifest.json`, `${DB}-production-daily-2030-01-15.sql.gz.age`]);
    assert.equal(await runCli(['download', '--backend', 'github', '--snapshot', 'daily/2030-01-15'], d), 1, 'bez --force nepřepíše');
    assert.equal(await runCli(['download', '--backend', 'github', '--snapshot', 'monthly/2030-01', `--output=${join(ROOT, 'tests')}`], d), 1, 'neignorovaná cesta v repozitáři odmítnuta');

    assert.equal(await runCli(['verify', '--file', file], d), 0);
    const keyFile = join(dir, 'key.txt');
    writeFileSync(keyFile, `# public key: ${recipient}\n${identity}\n`, { mode: 0o600 });
    assert.equal(await runCli(['verify', '--file', file, '--identity', keyFile], d), 0);
    assert.equal(await runCli(['decrypt', '--file', file, '--identity', keyFile], d), 0);
    const sql = readFileSync(join(out, `${DB}-production-daily-2030-01-15.sql`));
    assert.equal(await sha256Hex(new Uint8Array(sql)), await sha256Hex(EXPORT));

    const wrongKey = join(dir, 'wrong.txt');
    writeFileSync(wrongKey, `${await generateX25519Identity()}\n`);
    assert.equal(await runCli(['decrypt', '--file', file, '--identity', wrongKey, '--output', join(dir, 'x')], d), 1);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    assert.equal(await runCli(['verify', '--file', file], d), 1);
    assert.ok(d.output.at(-1)?.includes('SHA-256'));
    assert.ok(!d.output.join('\n').includes(identity) && !d.output.join('\n').includes(GH_READ_TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integrace: export → gzip → age → GitHub → stažení → rozšifrování → obnova do NOVÉ D1 → schéma, migrace a počty odpovídají', async () => {
  await runGithubBackup(ENV, deps());
  const dir = mkdtempSync(join(tmpdir(), 'backup-restore-'));
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-05-01', d1Databases: { DB: 'restore-github' } });
  try {
    const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
    const keyFile = join(dir, 'key.txt');
    writeFileSync(keyFile, `${identity}\n`, { mode: 0o600 });
    const args = ['restore', '--backend', 'github', '--snapshot', 'latest', '--target', 'restore-test-2030', '--identity', keyFile];

    // Bez potvrzení (neinteraktivně) se nic nevytvoří.
    const refused = cli(dir, d1);
    assert.equal(await runCli(args, refused), 1);
    assert.ok(!refused.wranglerCalls.some((a) => a[1] === 'create'));
    // Cíl = zdrojová nebo existující D1 → odmítnuto.
    const source = cli(dir, d1);
    assert.equal(await runCli(['restore', '--backend', 'github', '--snapshot', 'latest', '--target', DB, '--identity', keyFile, '--confirm', DB], source), 1);
    const existing = cli(dir, d1, ['restore-test-2030']);
    assert.equal(await runCli([...args, '--confirm', 'restore-test-2030'], existing), 1);
    assert.ok(!existing.wranglerCalls.some((a) => a[1] === 'create'));

    const ok = cli(dir, d1);
    assert.equal(await runCli([...args, '--confirm', 'restore-test-2030'], ok), 0, ok.output.join('\n'));
    assert.ok(ok.output.some((l) => l.startsWith('Obnova ověřena: 10 migrací')));
    assert.deepEqual(ok.wranglerCalls.map((a) => a.slice(0, 2).join(' ')), ['d1 list', 'd1 create', 'd1 execute', 'd1 execute']);
    assert.ok(ok.wranglerCalls.every((a) => !a.includes(DB)), 'zdrojová databáze se nikdy nepoužije');
    // Obnovená D1: migrace, počty, prostředí a funkční trigger.
    const count = async (sql: string) => (await d1.prepare(sql).first<{ n: number }>())!.n;
    assert.equal(await count('SELECT count(*) AS n FROM d1_migrations'), 10);
    for (const [table, n] of expectedRowCounts(new TextDecoder().decode(EXPORT))) assert.equal(await count(`SELECT count(*) AS n FROM "${table}"`), n, table);
    assert.equal((await d1.prepare("SELECT value FROM meta WHERE key = 'environment'").first<{ value: string }>())!.value, 'production');
    // Dočasné SQL smazáno (osobní údaje), žádné SQL ve výstupu.
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('d1-restore-')), []);
    assert.ok(!ok.output.join('\n').includes('INSERT INTO'));
  } finally {
    await mf.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('obnova z lokálního souboru (bez přístupu ke GitHubu) a ověření výstupu do ignorované cesty repozitáře', async () => {
  await runGithubBackup(ENV, deps());
  const dir = mkdtempSync(join(tmpdir(), 'backup-local-'));
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-05-01', d1Databases: { DB: 'restore-local' } });
  try {
    const d = cli(dir);
    assert.equal(await runCli(['download', '--backend', 'github', '--snapshot', 'monthly/2030-01', '--output', dir], d), 0);
    const file = join(dir, `${DB}-production-monthly-2030-01.sql.gz.age`);
    const keyFile = join(dir, 'key.txt');
    writeFileSync(keyFile, `${identity}\n`);
    const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
    const offline = cli(dir, d1);
    offline.env = { BACKUP_CLOUDFLARE_ACCOUNT_ID: ENV.BACKUP_CLOUDFLARE_ACCOUNT_ID };
    offline.fetch = async () => assert.fail('obnova ze souboru nepotřebuje síť');
    assert.equal(await runCli(['restore', '--file', file, '--identity', keyFile, '--target', 'restore-local-2030', '--confirm', 'restore-local-2030'], offline), 0, offline.output.join('\n'));
    assert.equal((await d1.prepare('SELECT count(*) AS n FROM reservations').first<{ n: number }>())!.n, 2);
    // Výstup do repozitáře jen do Gitem ignorované cesty.
    const ignored = join(ROOT, '.d1-backups', 'test-cli-output');
    try {
      mkdirSync(ignored, { recursive: true });
      assert.equal(await runCli(['decrypt', '--file', file, '--identity', keyFile, '--output', ignored], d), 0);
    } finally {
      rmSync(ignored, { recursive: true, force: true });
    }
  } finally {
    await mf.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Šablona GitHub Actions a nezávislý monitor ---------------------------------------------------------

test('šablona Actions: auditovaný commit, akce připnuté na SHA, minimální oprávnění, bez PR spouštěčů, secrets jen v kroku zálohy', () => {
  const text = readFileSync(join(ROOT, 'backup/github-actions/d1-backup.yml'), 'utf8');
  const yaml = text.replace(/^[ \t]*#.*\n/gm, '');
  // Neaktivní ve veřejném repozitáři (kopíruje se do soukromého).
  assert.ok(!existsSync(join(ROOT, '.github/workflows/d1-backup.yml')));
  assert.match(yaml, /^on:\n {2}schedule:\n {4}- cron: '17 2 \* \* \*'\n {2}workflow_dispatch:/m);
  assert.ok(!/pull_request|workflow_run|issue_comment|push:/.test(yaml), 'žádné spouštěče z cizího kódu');
  assert.match(yaml, /^permissions:\n {2}contents: write\n\n/m);
  assert.match(yaml, /^concurrency:\n {2}group: d1-backup-production\n {2}cancel-in-progress: false/m);
  assert.match(yaml, /timeout-minutes: 20/);
  const uses = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2 && uses.every((u) => /^actions\/[a-z-]+@[0-9a-f]{40}$/.test(u)), uses.join(', '));
  assert.match(yaml, /ref: \$\{\{ env\.CODE_COMMIT \}\}/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /test "\$\(git rev-parse HEAD\)" = "\$CODE_COMMIT"/);
  assert.match(yaml, /pnpm install --frozen-lockfile --ignore-scripts/);
  // Secrets jen v posledním kroku (Záloha), nikdy v instalaci ani v top-level env.
  const steps = yaml.split(/\n {6}- name: /);
  const withSecrets = steps.filter((s) => s.includes('secrets.') || s.includes('github.token'));
  assert.equal(withSecrets.length, 1);
  assert.ok(withSecrets[0].startsWith('Záloha'));
  assert.ok(!/AGE-SECRET-KEY/.test(text));
  assert.ok(/BACKUP_AGE_RECIPIENT: age1/.test(yaml));
  // Placeholder commitu nesmí projít kontrolou.
  assert.match(yaml, /!= 0{40}/);
});

test('monitor Worker: samostatný, jen cron, bez veřejné URL a bez secrets v konfiguraci; Workers Builds ho nenasazuje', async () => {
  const { parseJsonc } = await import('../scripts/lib/d1-migrations.ts');
  const config = parseJsonc(readFileSync(join(ROOT, 'wrangler.backup-monitor.jsonc'), 'utf8')) as Record<string, any>;
  assert.equal(config.main, './worker/backup-monitor/index.ts');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.triggers, { crons: ['43 14 * * *'] });
  assert.deepEqual(Object.keys(config.vars).sort(), ['BACKUP_BACKEND', 'BACKUP_DATABASE_NAME', 'BACKUP_ENV']);
  assert.equal(config.d1_databases ?? config.r2_buckets, undefined, 'žádné bindingy');
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  for (const name of ['build', 'deploy', 'deploy:preview']) assert.ok(!scripts[name].includes('backup'), name);
  const worker = (await import('../worker/backup-monitor/index.ts')).default;
  assert.equal((await worker.fetch()).status, 404);
});
