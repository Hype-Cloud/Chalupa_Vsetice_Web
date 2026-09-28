# Chalupa Všetice – web

Prezentační web rekreační chalupy ve Všeticích (Středočeský kraj). Jde o jednostránkovou
aplikaci v Reactu a TypeScriptu. Při buildu se celá předgeneruje do statického HTML
a nasazuje se na Cloudflare Workers Static Assets.

- Testovací prostředí: https://chalupa-vsetice-web.gamemanlpvlogs.workers.dev/
- Produkční doména: chalupavsetice.cz (připravuje se)

## Funkce

- **Úvodní sekce, informace o chalupě, vybavení a ceník** jsou responzivní a na
  mobilu (≤ 640 px) se přeskládají do jednoho sloupce.
- **Kalendář obsazenosti** se vkládá jako iframe z rezervačního systému
  [e-chalupy.cz](https://www.e-chalupy.cz/). Výšku iframe přizpůsobuje skript
  `resize.js` od poskytovatele. Vzhled kalendáře určuje vlastní stylopis
  `public/calendar.css`, který se předává parametrem `extCss`.
- **Orientační kalkulace ceny** podle zvoleného data příjezdu a odjezdu probíhá čistě
  na klientu, nic neodesílá a nic nerezervuje.
- **Poptávka** odkazuje na profil objektu na e-chalupy.cz. Ten slouží jako centrální
  rezervační systém a synchronizuje obsazenost s dalšími portály.
- **WebMCP:** pokud prohlížeč podporuje experimentální API `document.modelContext`,
  stránka v něm zaregistruje nástroj `estimate_stay` pro výpočet orientační ceny.
- **Stránka 404** se vygeneruje při buildu (`404.html`).

Web nemá vlastní backend, databázi ani API. Rezervace a dostupnost spravuje výhradně
e-chalupy.cz.

## Technologie

| Oblast | Technologie |
|---|---|
| UI | React 19, TypeScript 5, [lucide-react](https://lucide.dev/) (ikony) |
| Framework | [vinext](https://github.com/cloudflare/vinext) – Next.js App Router API nad Vite 8 |
| Styly | Vlastní CSS (`app/globals.css`), Tailwind CSS 4 + PostCSS |
| Výstup | Statický export (`output: "export"`), předrenderování při buildu |
| Hosting | Cloudflare Workers Static Assets |
| CI/CD | Cloudflare Workers Builds napojené na GitHub |
| Balíčky | pnpm 11 (`pnpm-lock.yaml`), Node.js 24 (`.node-version`) |

## Architektura

```
app/
  layout.tsx        HTML kostra, metadata (title, description, favicon)
  page.tsx          obsah stránky, kalkulace ceny, komponenta kalendáře
  globals.css       styly webu včetně responzivních breakpointů
public/
  calendar.css      stylopis kalendáře e-chalupy (načítaný přes jsDelivr)
  chalupa.jpg       fotografie objektu
  favicon.svg
scripts/
  finalize-static.mjs   úklid po buildu, ponechá pouze statický výstup
components/ui/, lib/, vendor/   knihovna komponent shadcn/ui (zatím nepoužitá)
vite.config.ts      vinext + Cloudflare Vite plugin (jen pro předrenderování)
next.config.ts      output: "export"
wrangler.jsonc      konfigurace Workeru a statických assetů
pnpm-workspace.yaml povolené build skripty a overrides pro pnpm
```

### Build pipeline

1. `vinext build` sestaví klientské, RSC a SSR prostředí přes Vite.
2. Při předrenderování se všechny routy vyrenderují do statického HTML.
   Pomocný Worker z Cloudflare Vite pluginu se použije jen během buildu.
3. `scripts/finalize-static.mjs` odstraní `dist/server` a `.wrangler/deploy`.
   Výsledkem je čistě statická složka `dist/client`.
4. `wrangler deploy` nahraje obsah `dist/client` jako statické assety Workeru
   `chalupa-vsetice-web`. Worker nemá žádný vlastní kód (`main`).

Soubory v `/_next/static/*` mají v názvu hash obsahu a posílají se s hlavičkou
`Cache-Control: public, max-age=31536000, immutable` (soubor `_headers`
vzniká při buildu).

## Instalace a lokální vývoj

Požadavky: Node.js 24 (viz `.node-version`) a pnpm 11.25 (viz `packageManager`
v `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm dev            # vývojový server Vite
pnpm run build      # produkční build do dist/client
pnpm preview        # lokální běh přes wrangler dev (Workers runtime)
```

## Konfigurace

- **Proměnné prostředí:** projekt žádné nepotřebuje a neobsahuje žádné klíče ani
  tajné hodnoty.
- **`wrangler.jsonc`:**

  ```jsonc
  {
    "name": "chalupa-vsetice-web",
    "compatibility_date": "2026-09-28",
    "assets": {
      "directory": "./dist/client",
      "not_found_handling": "404-page"
    }
  }
  ```

- **`pnpm-workspace.yaml`:**
  - `allowBuilds` povoluje instalační skripty `esbuild` a `workerd`, které pnpm 11
    jinak blokuje.
  - `overrides` fixuje `miniflare>sharp` na verzi 0.35.4.
- **Kalendář e-chalupy:** parametry iframe (ID objektu, barvy, počet měsíců,
  `extCss`) jsou v konstantě `calendarUrl` v `app/page.tsx`.

## Nasazení

Nasazení zajišťuje Cloudflare Workers Builds napojené na tento repozitář:

| Nastavení | Hodnota |
|---|---|
| Root directory | `/` |
| Build command | `pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `NODE_VERSION=24.19.0`, `PNPM_VERSION=11.25.0` |

- Push do větve `main` nasadí novou produkční verzi.
- Ostatní větve a pull requesty vytvoří náhledovou verzi (Worker Previews, vyžaduje
  Wrangler ≥ 4.135.0).

### Stylopis kalendáře

Kalendář e-chalupy načítá `public/calendar.css` z CDN jsDelivr:

```
https://cdn.jsdelivr.net/gh/Hype-Cloud/Chalupa_Vsetice_Web@main/public/calendar.css
```

Soubor se tedy nečte z nasazeného Workeru, ale přímo z větve `main`. Jeho změna se
v kalendáři projeví i bez nového deploye, ale až po obnovení cache jsDelivr, což může
trvat až několik hodin.
