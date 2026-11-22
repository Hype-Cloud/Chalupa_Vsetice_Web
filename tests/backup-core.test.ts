import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { parseBackupConfig, parseGithubRepo } from '../lib/backup/config.ts';
import { inspectSql, sha256Hex, verifyGenericDatabaseIdentity } from '../lib/backup/core.ts';
import { isAgeFile, openSnapshot, parseIdentityFile, sealSnapshot } from '../lib/backup/seal.ts';
import { buildManifest, latestSnapshot, manifestFor, manifestProblems, parseSnapshotId, selectForRetention, snapshotBaseName } from '../lib/backup/snapshot.ts';

// Společné jádro záloh (lib/backup): konfigurace, snapshoty a manifest, retence, gzip + age.
// Klíče age jsou syntetické (generované v testu), nikdy skutečné.

const ROOT = new URL('..', import.meta.url).pathname;
const EXPORT = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/d1-export.sql')));

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);

const GITHUB = {
  BACKUP_BACKEND: 'github',
  BACKUP_ENV: 'production',
  BACKUP_DATABASE_NAME: 'chalupa-vsetice-rezervace',
  BACKUP_DATABASE_ID: '00000000-0000-4000-8000-0000000000d1',
  BACKUP_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  BACKUP_GITHUB_REPO: 'example-owner/d1-backups',
  BACKUP_AGE_RECIPIENT: recipient,
};

// --- Konfigurace -----------------------------------------------------------------------------------

test('konfigurace: GitHub výchozí hodnoty (30/12, age), owner/repo i URL repozitáře', () => {
  const { config, errors } = parseBackupConfig(GITHUB, { backend: 'github', purpose: 'backup' });
  assert.deepEqual(errors, []);
  assert.equal(config?.keepDaily, 30);
  assert.equal(config?.keepMonthly, 12);
  assert.deepEqual(config?.encryption, { mode: 'age', recipients: [recipient] });
  assert.deepEqual(config?.github, { owner: 'example-owner', repo: 'd1-backups' });
  assert.equal(config?.r2, null);
  assert.deepEqual(parseGithubRepo('https://github.com/example-owner/d1-backups.git'), { owner: 'example-owner', repo: 'd1-backups' });
  for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a/b/c', 'a/b/c', 'a', 'https://github.com/a/b?x=1', 'a/..']) assert.equal(parseGithubRepo(bad), null, bad);
});

test('generic D1 profil podporuje jiné tabulky bez Chalupa metadata a migrací', () => {
  const sql = new TextEncoder().encode('PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE books(id INTEGER PRIMARY KEY, title TEXT);\nINSERT INTO "books" VALUES(1,\'Test\');\n');
  const generic = inspectSql(sql, 'production', 'generic');
  assert.deepEqual(generic.problems, []);
  assert.equal(generic.migrations, 0);
  assert.ok(inspectSql(sql, 'production').problems.length > 0, 'Chalupa profil zůstává přísný');
  const parsed = parseBackupConfig({ ...GITHUB, BACKUP_SCHEMA_PROFILE: 'generic' }, { backend: 'github', purpose: 'backup' });
  assert.equal(parsed.config?.schemaProfile, 'generic');
  assert.ok(parseBackupConfig({ ...GITHUB, BACKUP_SCHEMA_PROFILE: 'invalid' }, { backend: 'github', purpose: 'backup' }).errors.length > 0);
});

test('konfigurace: backend musí být explicitní a odpovídat spouštěči', () => {
  const { BACKUP_BACKEND: _, ...withoutBackend } = GITHUB;
  assert.ok(parseBackupConfig(withoutBackend, { purpose: 'backup' }).errors.some((e) => e.includes('BACKUP_BACKEND')));
  assert.ok(parseBackupConfig(GITHUB, { backend: 'r2', purpose: 'backup' }).errors.some((e) => e.includes('neodpovídá')));
  assert.ok(parseBackupConfig({ ...GITHUB, BACKUP_BACKEND: 's3' }, { purpose: 'backup' }).errors.length > 0);
});

test('konfigurace: produkce v GitHubu bez šifrování nebo s neplatným klíčem → chyba (fail closed)', () => {
  assert.ok(parseBackupConfig({ ...GITHUB, BACKUP_ENCRYPTION: 'none' }, { backend: 'github', purpose: 'backup' }).errors.some((e) => e.includes('šifrovaná')));
  assert.ok(parseBackupConfig({ ...GITHUB, BACKUP_AGE_RECIPIENT: '' }, { backend: 'github', purpose: 'backup' }).errors.some((e) => e.includes('BACKUP_AGE_RECIPIENT')));
  assert.ok(parseBackupConfig({ ...GITHUB, BACKUP_AGE_RECIPIENT: 'age1replacewithyourpublickey' }, { backend: 'github', purpose: 'backup' }).config === null);
  // Preview smí výslovně bez šifrování (testovací data).
  assert.equal(parseBackupConfig({ ...GITHUB, BACKUP_ENV: 'preview', BACKUP_ENCRYPTION: 'none' }, { backend: 'github', purpose: 'backup' }).config?.encryption.mode, 'none');
});

test('konfigurace: soukromý klíč v prostředí zálohy je odmítnut a chyby nikdy neobsahují hodnoty', () => {
  const { errors } = parseBackupConfig({ ...GITHUB, SOMETHING: identity, BACKUP_KEEP_DAILY: 'tajne-hodnota-x' }, { backend: 'github', purpose: 'backup' });
  assert.ok(errors.some((e) => e.includes('soukromý klíč')));
  const text = errors.join('\n');
  assert.ok(!text.includes(identity) && !text.includes('tajne-hodnota-x'));
  // Lokální čtení (CLI s --identity) klíč v prostředí nezakazuje.
  assert.ok(!parseBackupConfig({ ...GITHUB, SOMETHING: identity }, { backend: 'github', purpose: 'read' }).errors.some((e) => e.includes('soukromý klíč')));
});

test('konfigurace: nepotřebné hodnoty nejsou povinné (GitHub bez R2, čtení bez exportu, R2 bez age)', () => {
  const read = parseBackupConfig({ BACKUP_BACKEND: 'github', BACKUP_ENV: 'production', BACKUP_DATABASE_NAME: 'db', BACKUP_GITHUB_REPO: 'o/r' }, { backend: 'github', purpose: 'read' });
  assert.deepEqual(read.errors, []);
  const r2 = parseBackupConfig({ BACKUP_BACKEND: 'r2', BACKUP_ENV: 'preview', BACKUP_DATABASE_NAME: 'db', BACKUP_DATABASE_ID: GITHUB.BACKUP_DATABASE_ID, BACKUP_CLOUDFLARE_ACCOUNT_ID: GITHUB.BACKUP_CLOUDFLARE_ACCOUNT_ID }, { backend: 'r2', purpose: 'backup' });
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.config?.encryption.mode, 'none');
  assert.equal(r2.config?.maxExportBytes, 150 * 1024 ** 2);
  assert.ok(parseBackupConfig({ BACKUP_BACKEND: 'r2', BACKUP_ENV: 'preview', BACKUP_DATABASE_NAME: 'db', BACKUP_MAX_EXPORT_BYTES: String(200 * 1024 ** 2) }, { backend: 'r2', purpose: 'monitor' }).errors.length > 0, 'R2 strop 150 MiB');
  assert.ok(parseBackupConfig({ BACKUP_BACKEND: 'r2', BACKUP_ENV: 'preview', BACKUP_DATABASE_NAME: 'db' }, { backend: 'r2', purpose: 'read' }).errors.some((e) => e.includes('BACKUP_R2_BUCKET')));
  for (const [name, value] of [['BACKUP_KEEP_DAILY', '0'], ['BACKUP_KEEP_MONTHLY', '-1'], ['BACKUP_DATABASE_NAME', 'a--b'], ['BACKUP_ENV', 'staging']]) {
    assert.ok(parseBackupConfig({ ...GITHUB, [name]: value }, { backend: 'github', purpose: 'backup' }).config === null, `${name}=${value}`);
  }
});

test('generic profil: Cloudflare D1 UUID a název databáze se ověřují před exportem', async () => {
  const config = {
    schemaProfile: 'generic' as const, accountId: GITHUB.BACKUP_CLOUDFLARE_ACCOUNT_ID,
    databaseId: GITHUB.BACKUP_DATABASE_ID, databaseName: 'other-d1',
    environment: 'production', apiToken: 'synthetic-token', maxExportBytes: 1024,
  };
  const requests: { url: string; method: string; token: string | null }[] = [];
  const deps = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', token: new Headers(init?.headers).get('authorization') });
      return Response.json({ success: true, result: { name: 'other-d1', uuid: GITHUB.BACKUP_DATABASE_ID } });
    },
    sleep: async () => undefined, log: () => undefined,
  };
  await verifyGenericDatabaseIdentity(config, deps);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.ok(requests[0].url.endsWith(`/d1/database/${GITHUB.BACKUP_DATABASE_ID}`));
  const mismatched = { ...deps, fetch: async () => Response.json({ success: true, result: { name: 'other-d1', uuid: 'different-db' } }) };
  await assert.rejects(verifyGenericDatabaseIdentity(config, mismatched), { kind: 'database-identity-mismatch' });
  const denied = { ...deps, fetch: async () => new Response(null, { status: 403 }) };
  await assert.rejects(verifyGenericDatabaseIdentity(config, denied), { kind: 'database-identity-check-failed' });
  await verifyGenericDatabaseIdentity({ ...config, schemaProfile: 'chalupa' }, { ...deps, fetch: async () => assert.fail('Chalupa profil nemění REST API') });
});

// --- Snapshoty, manifest, retence --------------------------------------------------------------------

test('snapshot: identifikátory s přísnou kontrolou data; názvy souborů', () => {
  assert.deepEqual(parseSnapshotId('daily/2030-02-28'), { type: 'daily', date: '2030-02-28' });
  assert.deepEqual(parseSnapshotId('monthly/2030-02'), { type: 'monthly', date: '2030-02' });
  for (const bad of ['daily/2030-02-30', 'daily/2030-2-1', 'monthly/2030-13', 'weekly/2030-01-01', 'daily/../x', 'latest']) assert.equal(parseSnapshotId(bad), null, bad);
  assert.equal(snapshotBaseName('chalupa', 'production', { type: 'daily', date: '2030-01-02' }), 'chalupa-production-daily-2030-01-02');
});

test('retence: ponechá N nejnovějších denních a M měsíčních, ostatní typy nemíchá', () => {
  const daily = Array.from({ length: 35 }, (_, i) => ({ type: 'daily' as const, date: `2030-01-${String(i + 1).padStart(2, '0')}`, id: i }));
  const valid = daily.filter((s) => parseSnapshotId(`daily/${s.date}`));
  const monthly = Array.from({ length: 14 }, (_, i) => ({ type: 'monthly' as const, date: `${2029 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, id: 100 + i }));
  const removed = selectForRetention([...valid, ...monthly], 30, 12);
  assert.deepEqual(removed.filter((s) => s.type === 'daily').map((s) => s.date), ['2030-01-01']);
  assert.deepEqual(removed.filter((s) => s.type === 'monthly').map((s) => s.date), ['2029-02', '2029-01']);
  assert.deepEqual(selectForRetention(monthly, 30, 0).length, 14);
  assert.equal(latestSnapshot([...valid, ...monthly])?.date, '2030-01-31');
});

test('manifest: tvar, identita a soubor; měsíční kopie mění jen snapshot a název', () => {
  const manifest = buildManifest({
    database: 'db',
    environment: 'production',
    snapshot: { type: 'daily', date: '2030-01-02' },
    exportedAt: '2030-01-02T02:17:00.000Z',
    bookmark: null,
    migrations: 10,
    sql: { bytes: 10, sha256: 'a'.repeat(64) },
    file: { name: 'db-production-daily-2030-01-02.sql.gz.age', bytes: 5, sha256: 'b'.repeat(64), compression: 'gzip', encryption: 'age', recipients: [recipient] },
  });
  assert.deepEqual(manifestProblems(manifest, { database: 'db', environment: 'production', snapshot: { type: 'daily', date: '2030-01-02' }, fileName: manifest.file.name }), []);
  assert.deepEqual(manifestProblems(manifest, { environment: 'preview' }), ['manifest-environment-mismatch']);
  assert.deepEqual(manifestProblems(manifest, { database: 'jina' }), ['manifest-database-mismatch']);
  assert.deepEqual(manifestProblems({ ...manifest, version: 2 }, {}), ['manifest-format']);
  assert.deepEqual(manifestProblems({ ...manifest, file: { ...manifest.file, sha256: 'x' } }, {}), ['manifest-file']);
  const monthly = manifestFor(manifest, { type: 'monthly', date: '2030-01' }, 'db-production-monthly-2030-01.sql.gz.age');
  assert.equal(monthly.snapshot.id, 'monthly/2030-01');
  assert.equal(monthly.file.sha256, manifest.file.sha256);
  assert.equal(monthly.file.name, 'db-production-monthly-2030-01.sql.gz.age');
  const text = JSON.stringify(manifest);
  assert.ok(!/token|password|secret|AGE-SECRET/i.test(text));
});

// --- gzip + age --------------------------------------------------------------------------------------

test('šifrování: SQL → gzip → age a zpět jen se soukromým klíčem; obsah bez klíče nečitelný', async () => {
  const sealed = await sealSnapshot(EXPORT, { mode: 'age', recipients: [recipient] });
  assert.equal(sealed.extension, '.sql.gz.age');
  assert.ok(isAgeFile(sealed.bytes));
  assert.equal(sealed.sha256, await sha256Hex(sealed.bytes));
  assert.ok(sealed.bytes.length < EXPORT.length, 'komprimováno');
  assert.ok(!Buffer.from(sealed.bytes).includes('INSERT INTO'), 'šifrovaný obsah neobsahuje SQL');
  const sql = await openSnapshot(sealed.bytes, { encryption: 'age', compression: 'gzip', identity });
  assert.equal(await sha256Hex(sql), await sha256Hex(EXPORT));
  assert.deepEqual(inspectSql(sql, 'production').problems, []);

  const other = await generateX25519Identity();
  await assert.rejects(openSnapshot(sealed.bytes, { encryption: 'age', compression: 'gzip', identity: other }), { kind: 'decryption-failed' });
  await assert.rejects(openSnapshot(sealed.bytes, { encryption: 'age', compression: 'gzip' }), { kind: 'identity-required' });
  const corrupted = sealed.bytes.slice();
  corrupted[corrupted.length - 20] ^= 0xff;
  await assert.rejects(openSnapshot(corrupted, { encryption: 'age', compression: 'gzip', identity }), { kind: 'decryption-failed' });
});

test('šifrování: neplatný nebo chybějící příjemce → chyba, nikdy nešifrovaný výstup', async () => {
  await assert.rejects(sealSnapshot(EXPORT, { mode: 'age', recipients: [] }), { kind: 'encryption-not-configured' });
  await assert.rejects(sealSnapshot(EXPORT, { mode: 'age', recipients: ['age1neplatny'] }), { kind: 'encryption-failed' });
  await assert.rejects(sealSnapshot(EXPORT, { mode: 'age', recipients: [identity] }), { kind: 'encryption-failed' });
  const plain = await sealSnapshot(EXPORT, { mode: 'none', recipients: [] });
  assert.equal(plain.extension, '.sql.gz');
  assert.equal(await sha256Hex(await openSnapshot(plain.bytes, { encryption: 'none', compression: 'gzip' })), await sha256Hex(EXPORT));
});

test('šifrování: soubor klíče z age-keygen; kompatibilita s nástrojem age (je-li nainstalovaný)', async (t) => {
  assert.equal(parseIdentityFile(`# created: 2030-01-01T00:00:00Z\n# public key: ${recipient}\n${identity}\n`), identity);
  assert.throws(() => parseIdentityFile(`# public key: ${recipient}\n`), { kind: 'identity-invalid' });
  if (spawnSync('age', ['--version']).status !== 0) {
    t.skip('nástroj age není nainstalovaný');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'age-interop-'));
  try {
    writeFileSync(join(dir, 'key.txt'), `${identity}\n`, { mode: 0o600 });
    const sealed = await sealSnapshot(EXPORT, { mode: 'age', recipients: [recipient] });
    writeFileSync(join(dir, 'snapshot.sql.gz.age'), sealed.bytes);
    const decrypted = spawnSync('age', ['--decrypt', '-i', join(dir, 'key.txt'), join(dir, 'snapshot.sql.gz.age')]);
    assert.equal(decrypted.status, 0);
    assert.equal(spawnSync('gzip', ['-dc'], { input: decrypted.stdout }).stdout.equals(Buffer.from(EXPORT)), true);
    // Opačný směr: soubor zašifrovaný nástrojem age otevře knihovna.
    writeFileSync(join(dir, 'plain.sql.gz'), spawnSync('gzip', ['-c'], { input: Buffer.from(EXPORT) }).stdout);
    const encrypted = spawnSync('age', ['-r', recipient, join(dir, 'plain.sql.gz')]);
    assert.equal(encrypted.status, 0);
    assert.equal(await sha256Hex(await openSnapshot(new Uint8Array(encrypted.stdout), { encryption: 'age', compression: 'gzip', identity })), await sha256Hex(EXPORT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
