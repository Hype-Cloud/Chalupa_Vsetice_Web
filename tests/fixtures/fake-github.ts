// Falešné REST API GitHub Releases pro testy záloh (in-memory).
import { createHash } from 'node:crypto';
const digestOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// Chová se jako GitHub v bodech,
// na kterých záloha závisí: drafty bez tagu, 422 při duplicitním tagu publikovaného releasu
// i duplicitním názvu assetu, stránkování výpisu, mazání releasu a tagu zvlášť.

export interface FakeAsset {
  id: number;
  name: string;
  size: number;
  digest: string;
  state: string;
  bytes: Uint8Array;
}

export interface FakeRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  body: string;
  created_at: string;
  published_at: string | null;
  assets: FakeAsset[];
}

export interface FakeGithubOptions {
  owner: string;
  repo: string;
  private?: boolean;
  /** Token s přístupem; jiný = 401. */
  token: string;
  /** Jen čtení (fine-grained Contents: Read-only) → zápis 403. */
  readOnlyTokens?: string[];
}

export class FakeGithub {
  releases: FakeRelease[] = [];
  tags = new Set<string>();
  requests: { method: string; url: string; auth: string | null }[] = [];
  private nextId = 1;
  private readonly options: FakeGithubOptions;
  /** Poruchy: upload (název assetu → HTTP status), poškození stahování, chyba výpisu stránky. */
  failUpload = new Map<string, number>();
  corruptDownloads = false;
  failListPage: number | null = null;
  /** Synchronizace souběhu: publikace čekají, dokud jich nedorazí `count` současně. */
  publishBarrier: { count: number; waiting: (() => void)[] } | null = null;
  now = () => new Date();

  constructor(options: FakeGithubOptions) {
    this.options = { private: true, ...options };
  }

  seed(release: Partial<Omit<FakeRelease, 'assets'>> & { tag_name: string; assets?: { name: string; bytes: Uint8Array }[] }): FakeRelease {
    const id = this.nextId++;
    const created = release.created_at ?? this.now().toISOString();
    const stored: FakeRelease = {
      id,
      tag_name: release.tag_name,
      name: release.name ?? release.tag_name,
      draft: release.draft ?? false,
      body: release.body ?? '',
      created_at: created,
      published_at: release.draft ? null : (release.published_at ?? created),
      assets: (release.assets ?? []).map((a) => ({ id: this.nextId++, name: a.name, size: a.bytes.length, digest: digestOf(a.bytes), state: 'uploaded', bytes: a.bytes })),
    };
    this.releases.push(stored);
    if (!stored.draft) this.tags.add(stored.tag_name);
    return stored;
  }

  private view(release: FakeRelease) {
    return { ...release, assets: release.assets.map(({ bytes: _bytes, ...asset }) => asset) };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get('authorization');
    this.requests.push({ method: request.method, url: request.url, auth });
    // Asynchronní hranice jako u sítě (souběh se může prolínat).
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (auth !== `Bearer ${this.options.token}` && !this.options.readOnlyTokens?.some((t) => auth === `Bearer ${t}`)) return json({ message: 'Bad credentials' }, 401);
    const readOnly = auth !== `Bearer ${this.options.token}`;
    const base = `/repos/${this.options.owner}/${this.options.repo}`;

    if (url.hostname === 'uploads.github.com') {
      if (readOnly) return json({ message: 'forbidden' }, 403);
      const match = new RegExp(`^${base}/releases/(\\d+)/assets$`).exec(url.pathname);
      const release = match && this.releases.find((r) => r.id === Number(match[1]));
      if (!release) return json({ message: 'Not Found' }, 404);
      const name = url.searchParams.get('name') ?? '';
      if (release.assets.some((a) => a.name === name)) return json({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }, 422);
      const failure = this.failUpload.get(name);
      if (failure) {
        // Přerušený upload zanechá neúplný asset (jako GitHub – stav „starter“).
        release.assets.push({ id: this.nextId++, name, size: 0, digest: digestOf(new Uint8Array()), state: 'starter', bytes: new Uint8Array() });
        return json({ message: 'upload failed' }, failure);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const asset = { id: this.nextId++, name, size: bytes.length, digest: digestOf(bytes), state: 'uploaded', bytes };
      release.assets.push(asset);
      const { bytes: _b, ...view } = asset;
      return json(view, 201);
    }

    if (url.hostname !== 'api.github.com') return json({ message: 'unexpected host' }, 599);
    const path = url.pathname;
    if (path === base && request.method === 'GET') {
      // Jako skutečný GitHub u GITHUB_TOKEN (GitHub App): `permissions.push` může být false
      // i u tokenu se zápisem obsahu – zápis se rozhoduje až u konkrétní operace.
      return json({ private: this.options.private, visibility: this.options.private ? 'private' : 'public', archived: false, permissions: { admin: false, push: false, pull: true } });
    }
    if (!path.startsWith(base)) return json({ message: 'Not Found' }, 404);
    const rest = path.slice(base.length);

    if (rest === '/releases' && request.method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      if (this.failListPage === page) return json({ message: 'Server Error' }, 500);
      const visible = this.releases.filter((r) => !r.draft || !readOnly).sort((a, b) => b.id - a.id);
      return json(visible.slice((page - 1) * perPage, page * perPage).map((r) => this.view(r)));
    }
    if (rest === '/releases' && request.method === 'POST') {
      if (readOnly) return json({ message: 'forbidden' }, 403);
      const body = (await request.json()) as { tag_name: string; name: string; body: string; draft: boolean };
      if (!body.draft && this.tags.has(body.tag_name)) return json({ message: 'Validation Failed' }, 422);
      const release = this.seed({ tag_name: body.tag_name, name: body.name, body: body.body, draft: body.draft });
      return json(this.view(release), 201);
    }
    let match = /^\/releases\/tags\/(.+)$/.exec(rest);
    if (match && request.method === 'GET') {
      const tag = decodeURIComponent(match[1]);
      const release = this.releases.find((r) => !r.draft && r.tag_name === tag);
      return release ? json(this.view(release)) : json({ message: 'Not Found' }, 404);
    }
    match = /^\/releases\/assets\/(\d+)$/.exec(rest);
    if (match && request.method === 'GET') {
      const asset = this.releases.flatMap((r) => r.assets).find((a) => a.id === Number(match![1]));
      if (!asset) return json({ message: 'Not Found' }, 404);
      const bytes = asset.bytes.slice();
      if (this.corruptDownloads && bytes.length > 0) bytes[bytes.length - 1] ^= 0xff;
      return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
    }
    match = /^\/releases\/(\d+)$/.exec(rest);
    if (match) {
      const index = this.releases.findIndex((r) => r.id === Number(match![1]));
      if (request.method === 'GET') {
        // Drafty vidí jen token s push (jako GitHub).
        if (index < 0 || (this.releases[index].draft && readOnly)) return json({ message: 'Not Found' }, 404);
        return json(this.view(this.releases[index]));
      }
      if (request.method === 'DELETE') {
        if (readOnly) return json({ message: 'forbidden' }, 403);
        if (index < 0) return json({ message: 'Not Found' }, 404);
        this.releases.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'PATCH') {
        if (readOnly) return json({ message: 'forbidden' }, 403);
        if (index < 0) return json({ message: 'Not Found' }, 404);
        const body = (await request.json()) as { draft?: boolean };
        const release = this.releases[index];
        if (body.draft === false && release.draft) {
          const barrier = this.publishBarrier;
          if (barrier) {
            if (barrier.waiting.length + 1 < barrier.count) await new Promise<void>((resolve) => barrier.waiting.push(resolve));
            else for (const resolve of barrier.waiting.splice(0)) resolve();
          }
          if (this.releases.some((r) => !r.draft && r.tag_name === release.tag_name)) return json({ message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'tag_name' }] }, 422);
          release.draft = false;
          release.published_at = this.now().toISOString();
          this.tags.add(release.tag_name);
        }
        return json(this.view(release));
      }
    }
    match = /^\/git\/refs\/tags\/(.+)$/.exec(rest);
    if (match && request.method === 'DELETE') {
      if (readOnly) return json({ message: 'forbidden' }, 403);
      const tag = decodeURIComponent(match[1]);
      if (!this.tags.delete(tag)) return json({ message: 'Reference does not exist' }, 422);
      return new Response(null, { status: 204 });
    }
    return json({ message: 'Not Found' }, 404);
  };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
