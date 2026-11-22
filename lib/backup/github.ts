// Backend GitHub Releases: šifrované snapshoty jako assety releasů v SOUKROMÉM repozitáři.
//
// - Jeden snapshot = jeden release s tagem `d1backup--<prostředí>--<databáze>--<typ>--<datum>`,
//   assety `<databáze>-<prostředí>-<typ>-<datum>.sql.gz.age` a `….manifest.json`. Releasy nejsou
//   commity: repozitář neroste a mazání při retenci je skutečné.
// - Zveřejnění: draft → upload obou assetů → stažení zpět a ověření SHA-256 → publikace
//   (PATCH draft=false) = atomický okamžik. Do té doby snapshot neexistuje; při jakékoli chybě
//   se vlastní draft smaže a nic se nehlásí jako úspěch.
// - Nikdy se nic nepřepisuje: existující snapshot se stejným obsahem = idempotentní úspěch
//   (`exists`), jiný obsah = chyba `snapshot-conflict` (denní) nebo ponechání (`kept`, měsíční).
//   Souběžná publikace stejného tagu: GitHub druhou odmítne (422) a vyhodnotí se existující.
// - Retence maže jen releasy jednoznačně rozpoznané jako snapshoty této databáze a prostředí
//   (přesný tag, značka v popisu, manifest); chyba výpisu = nic se nemaže.
// - Repozitář musí být soukromý (ověřuje se před každým zápisem i čtením).
// Limity GitHubu (ověřeno v dokumentaci): asset < 2 GiB, max. 1000 assetů na release, celková
// velikost ani přenos releasů omezené nejsou; duplicitní název assetu = 422.

import { BackupError, sha256Hex, type CoreDeps } from './core.ts';
import { isAgeFile } from './seal.ts';
import { manifestProblems, parseSnapshotId, selectForRetention, snapshotBaseName, snapshotId, type SnapshotManifest, type SnapshotRef } from './snapshot.ts';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_UPLOADS = 'https://uploads.github.com';
export const RELEASE_MARKER = '<!-- d1-backup:v1 -->';
/** Asset musí být menší než 2 GiB. */
export const GITHUB_ASSET_LIMIT = 2 * 1024 ** 3 - 1;
/** Draft starší než 24 h je pozůstatek neúspěšného běhu – smí se smazat. */
export const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const ATTEMPTS = 3;

export interface GithubTarget {
  owner: string;
  repo: string;
  database: string;
  environment: string;
}

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
  state?: string;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  body: string | null;
  created_at: string;
  published_at: string | null;
  assets: GithubAsset[];
}

export interface GithubSnapshot extends SnapshotRef {
  id: number;
  release: GithubRelease;
  file: GithubAsset;
  manifest: GithubAsset;
}

export type GithubDeps = Pick<CoreDeps, 'fetch' | 'sleep' | 'log'> & { now: () => Date };

export const releaseTag = (target: Pick<GithubTarget, 'database' | 'environment'>, ref: SnapshotRef) => `d1backup--${target.environment}--${target.database}--${ref.type}--${ref.date}`;
export const manifestName = (target: Pick<GithubTarget, 'database' | 'environment'>, ref: SnapshotRef) => `${snapshotBaseName(target.database, target.environment, ref)}.manifest.json`;
const fileNames = (target: GithubTarget, ref: SnapshotRef) => ['.sql.gz.age', '.sql.gz'].map((ext) => `${snapshotBaseName(target.database, target.environment, ref)}${ext}`);

/** Druh chyby podle HTTP odpovědi GitHubu (bez obsahu odpovědi). */
function httpKind(response: Response): string {
  if (response.status === 401) return 'github-auth';
  if (response.status === 403 || response.status === 429) {
    return response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ? 'github-rate-limited' : 'github-forbidden';
  }
  if (response.status === 404) return 'github-not-found';
  if (response.status === 422) return 'github-rejected';
  if (response.status >= 500) return 'github-unavailable';
  return `github-http-${response.status}`;
}

/** Klient REST API GitHubu – jen operace, které záloha potřebuje. Token se nikdy neloguje. */
export class GithubClient {
  readonly target: GithubTarget;
  private readonly token: string;
  readonly deps: GithubDeps;

  constructor(target: GithubTarget, token: string, deps: GithubDeps) {
    if (!token.trim()) throw new BackupError('github-token-missing');
    this.target = target;
    this.token = token.trim();
    this.deps = deps;
  }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'd1-backup' };
  }

  private repoPath(path: string) {
    return `${GITHUB_API}/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repo)}${path}`;
  }

  /** Požadavek s opakováním jen u výpadku sítě, 5xx a rate limitu s krátkým Retry-After. */
  private async send(url: string, init: RequestInit & { timeout?: number }): Promise<Response> {
    let lastKind = 'github-unavailable';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? REQUEST_TIMEOUT_MS) });
      } catch {
        lastKind = 'github-unavailable';
        if (attempt < ATTEMPTS) await this.deps.sleep(2_000 * attempt);
        continue;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const retryable = response.status >= 500 || ((response.status === 403 || response.status === 429) && retryAfter > 0 && retryAfter <= 60);
      if (!retryable || attempt === ATTEMPTS) return response;
      lastKind = httpKind(response);
      await response.body?.cancel().catch(() => undefined);
      await this.deps.sleep(retryAfter > 0 ? retryAfter * 1000 : 2_000 * attempt);
    }
    throw new BackupError(lastKind);
  }

  private async json<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T | null }> {
    const response = await this.send(this.repoPath(path), {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, data: null };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackupError(httpKind(response));
    }
    if (response.status === 204) return { status: 204, data: null };
    try {
      return { status: response.status, data: (await response.json()) as T };
    } catch {
      throw new BackupError('github-invalid-response');
    }
  }

  /** Repozitář musí existovat, být soukromý a token musí mít požadovaný přístup. */
  async assertPrivateRepository(access: 'read' | 'write'): Promise<void> {
    const { data } = await this.json<{ private?: boolean; visibility?: string; permissions?: { push?: boolean; pull?: boolean }; archived?: boolean }>('GET', '');
    if (!data || data.private !== true || (data.visibility !== undefined && data.visibility === 'public')) throw new BackupError('repository-not-private');
    if (access === 'write' && data.archived) throw new BackupError('repository-archived');
    // `permissions` vrací GitHub jen pro uživatelské tokeny; u GITHUB_TOKEN chybí (ověří zápis sám).
    if (access === 'write' && data.permissions && data.permissions.push === false) throw new BackupError('github-forbidden');
  }

  /** Všechny releasy (včetně draftů viditelných tokenu s push). Chyba kterékoli stránky = výjimka. */
  async listReleases(): Promise<GithubRelease[]> {
    const all: GithubRelease[] = [];
    for (let page = 1; page <= 100; page++) {
      let data: GithubRelease[] | null;
      try {
        ({ data } = await this.json<GithubRelease[]>('GET', `/releases?per_page=100&page=${page}`));
      } catch (error) {
        throw new BackupError(error instanceof BackupError && error.kind === 'github-auth' ? 'github-auth' : 'list-failed');
      }
      if (!Array.isArray(data)) throw new BackupError('list-failed');
      all.push(...data);
      if (data.length < 100) return all;
    }
    // Více než 10 000 releasů – výpis není úplný, retence by mohla rozhodnout špatně.
    throw new BackupError('list-failed');
  }

  /** Publikovaný release s tagem, nebo null (drafty tag nemají). */
  async releaseByTag(tag: string): Promise<GithubRelease | null> {
    const { data } = await this.json<GithubRelease>('GET', `/releases/tags/${encodeURIComponent(tag)}`, undefined, [404]);
    return data;
  }

  async createDraft(tag: string, name: string, body: string): Promise<GithubRelease> {
    const { data } = await this.json<GithubRelease>('POST', '/releases', { tag_name: tag, name, body, draft: true, prerelease: false, generate_release_notes: false });
    if (!data || typeof data.id !== 'number' || data.draft !== true) throw new BackupError('github-invalid-response');
    return data;
  }

  /** Publikace draftu; 422 = tag mezitím obsadil jiný release (souběh) → null. */
  async publish(releaseId: number): Promise<GithubRelease | null> {
    const { status, data } = await this.json<GithubRelease>('PATCH', `/releases/${releaseId}`, { draft: false, make_latest: 'false' }, [422]);
    return status === 422 ? null : data;
  }

  /** Smazání releasu (404 = už smazaný, např. souběžnou retencí). */
  async deleteRelease(releaseId: number): Promise<void> {
    await this.json('DELETE', `/releases/${releaseId}`, undefined, [404]);
  }

  /** Smazání tagu (release ho nemaže); 404/422 = tag neexistuje. */
  async deleteTag(tag: string): Promise<void> {
    await this.json('DELETE', `/git/refs/tags/${encodeURIComponent(tag)}`, undefined, [404, 422]);
  }

  async uploadAsset(releaseId: number, name: string, bytes: Uint8Array, contentType: string): Promise<GithubAsset> {
    if (bytes.length > GITHUB_ASSET_LIMIT) throw new BackupError('asset-too-large');
    const url = `${GITHUB_UPLOADS}/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repo)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    let response: Response;
    try {
      // Bez opakování: přerušený upload může zanechat asset a opakování by skončilo 422 –
      // celý snapshot se zopakuje s novým draftem.
      response = await this.deps.fetch(url, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': contentType, 'content-length': String(bytes.length) },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
    } catch {
      throw new BackupError('upload-failed');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackupError(response.status === 422 ? 'upload-rejected' : 'upload-failed');
    }
    const asset = (await response.json().catch(() => null)) as GithubAsset | null;
    if (!asset || typeof asset.id !== 'number' || asset.name !== name || asset.size !== bytes.length || (asset.state !== undefined && asset.state !== 'uploaded')) {
      throw new BackupError('upload-failed');
    }
    return asset;
  }

  /** Obsah assetu (přesměrování na podepsanou URL řeší fetch; Authorization se cizí doméně neposílá). */
  async downloadAsset(asset: Pick<GithubAsset, 'id' | 'size'>, maxBytes = GITHUB_ASSET_LIMIT): Promise<Uint8Array> {
    if (asset.size > maxBytes) throw new BackupError('asset-too-large');
    const response = await this.send(this.repoPath(`/releases/assets/${asset.id}`), { method: 'GET', headers: this.headers('application/octet-stream'), redirect: 'follow', timeout: TRANSFER_TIMEOUT_MS });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackupError(response.status === 404 ? 'snapshot-not-found' : 'download-failed');
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new BackupError('download-interrupted');
    }
    if (bytes.length !== asset.size) throw new BackupError('size-mismatch');
    return bytes;
  }
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Release → snapshot této databáze a prostředí, jinak null (cizí releasy se nikdy nedotknou). */
export function identifySnapshot(target: GithubTarget, release: GithubRelease): GithubSnapshot | null {
  const pattern = new RegExp(`^d1backup--${escapeRegex(target.environment)}--${escapeRegex(target.database)}--(daily|monthly)--([0-9-]{7,10})$`);
  const match = pattern.exec(release.tag_name ?? '');
  if (!match || !(release.body ?? '').includes(RELEASE_MARKER)) return null;
  const ref = parseSnapshotId(`${match[1]}/${match[2]}`);
  if (!ref) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const manifest = assets.find((a) => a.name === manifestName(target, ref));
  const names = fileNames(target, ref);
  const files = assets.filter((a) => names.includes(a.name));
  if (!manifest || files.length !== 1) return null;
  return { ...ref, id: release.id, release, file: files[0], manifest };
}

/** Publikované snapshoty této databáze a prostředí (drafty a cizí releasy vynechány). */
export async function listSnapshots(client: GithubClient): Promise<{ snapshots: GithubSnapshot[]; drafts: GithubRelease[] }> {
  const releases = await client.listReleases();
  const snapshots: GithubSnapshot[] = [];
  const drafts: GithubRelease[] = [];
  const draftPrefix = `d1backup--${client.target.environment}--${client.target.database}--`;
  for (const release of releases) {
    if (release.draft) {
      if ((release.tag_name ?? '').startsWith(draftPrefix) && (release.body ?? '').includes(RELEASE_MARKER)) drafts.push(release);
      continue;
    }
    const snapshot = identifySnapshot(client.target, release);
    if (snapshot) snapshots.push(snapshot);
  }
  return { snapshots, drafts };
}

/** Stažený a ověřený snapshot: manifest odpovídá identitě, soubor velikosti a SHA-256 manifestu. */
export async function downloadSnapshot(client: GithubClient, snapshot: GithubSnapshot): Promise<{ manifest: SnapshotManifest; bytes: Uint8Array }> {
  const raw = await client.downloadAsset(snapshot.manifest, 1024 ** 2);
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new BackupError('manifest-invalid');
  }
  const problems = manifestProblems(manifest, { database: client.target.database, environment: client.target.environment, snapshot, fileName: snapshot.file.name });
  if (problems.length > 0) {
    client.deps.log(`d1-backup: manifest check failed (${problems.join(',')})`);
    throw new BackupError('manifest-invalid');
  }
  const m = manifest as SnapshotManifest;
  // Produkční snapshot musí být zašifrovaný také při opakovaném běhu a stažení.
  if (client.target.environment === 'production' && (
    m.file.encryption !== 'age' || m.file.compression !== 'gzip' ||
    !m.file.name.endsWith('.sql.gz.age') || m.file.recipients.length === 0 ||
    !m.file.recipients.every((recipient) => typeof recipient === 'string' && recipient.startsWith('age1'))
  )) throw new BackupError('snapshot-encryption-invalid');
  if (m.file.bytes !== snapshot.file.size) throw new BackupError('size-mismatch');
  const bytes = await client.downloadAsset(snapshot.file);
  if ((await sha256Hex(bytes)) !== m.file.sha256) throw new BackupError('checksum-mismatch');
  if (client.target.environment === 'production' && !isAgeFile(bytes)) throw new BackupError('snapshot-encryption-invalid');
  return { manifest: m, bytes };
}

export type ExistingPolicy = 'verify' | 'keep';
export type PublishState = 'stored' | 'exists' | 'kept';

function releaseBody(manifest: SnapshotManifest): string {
  return [
    RELEASE_MARKER,
    `Záloha D1 \`${manifest.database}\` (${manifest.environment}), snapshot \`${manifest.snapshot.id}\`.`,
    '',
    `Soubor je ${manifest.file.encryption === 'age' ? 'zašifrovaný (age) a ' : ''}komprimovaný (gzip); SHA-256 a metadata jsou v manifestu.`,
    'Snapshot nemazat ani neměnit ručně – retenci řídí zálohovací skript. Obnova: README, „Automatické zálohy D1“.',
  ].join('\n');
}

/** Existující snapshot podle politiky: stejný obsah = exists; měsíční ponechat = kept; jinak konflikt. */
async function evaluateExisting(client: GithubClient, release: GithubRelease, manifest: SnapshotManifest, policy: ExistingPolicy): Promise<PublishState> {
  const existing = identifySnapshot(client.target, release);
  if (!existing) throw new BackupError('snapshot-conflict');
  const stored = await downloadSnapshot(client, existing);
  // age používá náhodné šifrování: stejný SQL export může mít jiné zašifrované bajty.
  if (stored.manifest.sql.sha256 === manifest.sql.sha256 &&
      stored.manifest.sql.bytes === manifest.sql.bytes &&
      stored.manifest.file.encryption === manifest.file.encryption &&
      JSON.stringify([...stored.manifest.file.recipients].sort()) === JSON.stringify([...manifest.file.recipients].sort())) return 'exists';
  if (policy === 'keep') return 'kept';
  throw new BackupError('snapshot-conflict');
}

/**
 * Zveřejní snapshot (soubor + manifest) jako release. Nikdy nepřepisuje existující snapshot;
 * úspěch vrací až po publikaci a ověření, že tag patří tomuto releasu s ověřenými assety.
 */
export async function publishSnapshot(client: GithubClient, ref: SnapshotRef, bytes: Uint8Array, manifest: SnapshotManifest, policy: ExistingPolicy): Promise<PublishState> {
  const tag = releaseTag(client.target, ref);
  if (manifest.snapshot.id !== snapshotId(ref) || manifest.file.bytes !== bytes.length || (await sha256Hex(bytes)) !== manifest.file.sha256) throw new BackupError('manifest-invalid');
  const existing = await client.releaseByTag(tag);
  if (existing) return evaluateExisting(client, existing, manifest, policy);

  const draft = await client.createDraft(tag, `D1 záloha ${manifest.database} (${manifest.environment}) ${snapshotId(ref)}`, releaseBody(manifest));
  let published = false;
  try {
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const fileAsset = await client.uploadAsset(draft.id, manifest.file.name, bytes, 'application/octet-stream');
    const manifestAsset = await client.uploadAsset(draft.id, manifestName(client.target, ref), manifestBytes, 'application/json');
    // Ověření uloženého obsahu před publikací (stažení zpět, SHA-256).
    if ((await sha256Hex(await client.downloadAsset(fileAsset))) !== manifest.file.sha256) throw new BackupError('upload-verify-failed');
    if ((await sha256Hex(await client.downloadAsset(manifestAsset, 1024 ** 2))) !== (await sha256Hex(manifestBytes))) throw new BackupError('upload-verify-failed');

    const result = await client.publish(draft.id);
    if (!result) {
      // Souběh: tag mezitím publikoval jiný běh – vlastní draft pryč, rozhodne existující snapshot.
      await client.deleteRelease(draft.id);
      const winner = await client.releaseByTag(tag);
      if (!winner) throw new BackupError('github-rejected');
      return evaluateExisting(client, winner, manifest, policy);
    }
    published = true;
    const check = await client.releaseByTag(tag);
    if (!check || check.id !== draft.id || check.draft) throw new BackupError('publish-verify-failed');
    const snapshot = identifySnapshot(client.target, check);
    if (!snapshot || snapshot.file.size !== bytes.length) throw new BackupError('publish-verify-failed');
    return 'stored';
  } catch (error) {
    // Neúplný snapshot se nikdy nehlásí jako úspěch; nepublikovaný draft se uklidí.
    if (!published) await client.deleteRelease(draft.id).catch(() => client.deps.log('d1-backup: draft cleanup failed'));
    throw error;
  }
}

/**
 * Retence po úspěšné záloze: smaže snapshoty nad limit a vlastní drafty starší než 24 h.
 * Chyba výpisu = nic se nesmaže. Vrací počet smazaných snapshotů.
 */
export async function applyRetention(client: GithubClient, keepDaily: number, keepMonthly: number, now: Date): Promise<number> {
  const { snapshots, drafts } = await listSnapshots(client);
  const remove = selectForRetention(snapshots, keepDaily, keepMonthly);
  for (const snapshot of remove) {
    // Dvojí kontrola identity těsně před smazáním (nikdy cizí release).
    if (!identifySnapshot(client.target, snapshot.release) || snapshot.release.draft) throw new BackupError('retention-failed');
    await client.deleteRelease(snapshot.id);
    await client.deleteTag(snapshot.release.tag_name);
  }
  for (const draft of drafts) {
    if (now.getTime() - Date.parse(draft.created_at) > STALE_DRAFT_MS) await client.deleteRelease(draft.id);
  }
  return remove.length;
}

export interface GithubStatus {
  latest: { id: string; published: string } | null;
  stale: boolean;
  dailyCount: number;
  monthlyCount: number;
  totalBytes: number;
}

/** Stav záloh pro kontrolu stáří (> 48 h) a upozornění. */
export async function githubStatus(client: GithubClient, now: Date, staleAfterMs: number, verifyStored = false): Promise<GithubStatus> {
  const { snapshots } = await listSnapshots(client);
  const daily = snapshots.filter((s) => s.type === 'daily').sort((a, b) => b.date.localeCompare(a.date));
  const latest = daily[0];
  const published = latest?.release.published_at ?? null;
  if (verifyStored) {
    // Neúplný nejnovější release nesmí zmizet z monitoringu jen proto, že mu chybí asset.
    const prefix = `d1backup--${client.target.environment}--${client.target.database}--daily--`;
    const releases = await client.listReleases();
    const candidates = releases.filter((r) => !r.draft && (r.body ?? '').includes(RELEASE_MARKER) &&
      r.tag_name.startsWith(prefix) && parseSnapshotId(`daily/${r.tag_name.slice(prefix.length)}`));
    candidates.sort((a, b) => b.tag_name.localeCompare(a.tag_name));
    if (candidates.length > 0 && (!latest || candidates[0].id !== latest.id)) throw new BackupError('snapshot-invalid');
    if (latest) await downloadSnapshot(client, latest);
  }
  return {
    latest: latest && published ? { id: snapshotId(latest), published } : null,
    stale: !published || now.getTime() - Date.parse(published) > staleAfterMs,
    dailyCount: daily.length,
    monthlyCount: snapshots.length - daily.length,
    totalBytes: snapshots.reduce((sum, s) => sum + s.file.size + s.manifest.size, 0),
  };
}
