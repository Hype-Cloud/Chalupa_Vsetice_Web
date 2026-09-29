# Chalupa Všetice – web

Prezentační web rekreační chalupy ve Všeticích (Středočeský kraj). Stránka je
jednostránková aplikace v Reactu a TypeScriptu předgenerovaná do statického HTML.
Obsazenost poskytuje malé API v Cloudflare Workeru. Web i API běží na
Cloudflare Workers.

- Produkce: https://chalupavsetice.cz/
- Testovací prostředí: https://chalupa-vsetice-web.gamemanlpvlogs.workers.dev/

## Funkce

- **Úvodní sekce, informace o chalupě, vybavení a ceník** jsou responzivní a na
  mobilu (≤ 640 px) se přeskládají do jednoho sloupce.
- **Rezervační kalendář** je vlastní React komponenta:
  - zobrazuje 1–3 měsíce podle skutečné šířky panelu a šipkami lze procházet
    12 měsíců dopředu,
  - má české názvy, začíná pondělím a zvýrazňuje dnešek,
  - rozlišuje volné a obsazené dny i dny příjezdu a odjezdu jiných hostů,
  - první klik vybere příjezd a druhý odjezd; pobyt přes obsazené období ani
    v minulosti vybrat nejde,
  - ovládá se myší, dotykem i klávesnicí (šipky, Enter, mezerník) a každý den má
    přístupný popisek.
- **Rezervační panel** sdílí s kalendářem jeden stav pobytu. Datumová pole
  procházejí stejnou validací a panel zobrazuje počet nocí, počet hostů
  (max. 7) a orientační cenu (3 000 Kč / noc).
- **Poptávka** vede na oficiální profil chalupy na e-chalupy.cz. Výběr termínu na
  webu není rezervací. Termín a počet hostů host uvede v poptávce na e-chalupách.
- **WebMCP:** pokud prohlížeč podporuje experimentální API `document.modelContext`,
  stránka zaregistruje nástroj `estimate_stay`. Ten vybere termín stejnou validací
  a vrátí orientační cenu; nevytváří rezervaci ani poptávku.

## Rezervace a obsazenost

Skutečné rezervace se spravují výhradně v aplikaci **e-chalupy**. Ta je
centrálním kalendářem a synchronizuje obsazenost s Airbnb a Booking.com. Web
obsazenost pouze **čte**:

```
e-chalupy (iCal export, GET) → Worker /api/availability → React kalendář
```

- Worker stahuje soukromý iCal export výhradně metodou GET. Nic nezapisuje a
  nemá žádný přístup pro zápis do e-chalup, Airbnb ani Booking.com.
- Adresa exportu je Cloudflare secret `ECHALUPY_ICAL_URL`. Není v repozitáři,
  v klientském kódu ani v odpovědích API a do logů se nikdy nevypisuje.
- Export parsuje knihovna [ical.js](https://github.com/kewisch/ical.js).
  - Celodenní události mají exkluzivní `DTEND`: obsazené jsou noci od příjezdu do
    dne odjezdu.
  - Časované události se převádějí na data v pásmu Europe/Prague.
  - Opakované události (`RRULE`, `RECURRENCE-ID`) se rozvinou a zrušené
    (`STATUS:CANCELLED`) se vynechají.
  - Překrývající se a navazující intervaly se sloučí.
  - Den odjezdu jedněch hostů zůstává volný pro příjezd dalších.
- API vrací jen obsazené intervaly (data), čas poslední synchronizace a stav.
  Jména, kontakty, popisy ani UID událostí se nepředávají.

### Cache a výpadky

| Situace | Chování API (`status`) | Kalendář |
|---|---|---|
| Data mladší než 10 minut | `ok` z cache (paměť izolátu + Cache API) | normální zobrazení |
| Cache vypršela, export dostupný | `ok`, export se stáhne znovu | normální zobrazení |
| Export nedostupný nebo neplatný, poslední data < 24 h | `stale` | data + upozornění na čas poslední synchronizace |
| Bez použitelných dat nebo bez secretu | `unavailable` | žádný den se netváří jako volný, výběr je zablokovaný, odkaz na e-chalupy |

- Po neúspěšném stažení se další pokus provede nejdřív za minutu.
- Neplatný iCal se nikdy nevyloží jako prázdný kalendář.
- Otevřená stránka obnovuje obsazenost každých 10 minut a při návratu na kartu.

## Technologie

| Oblast | Technologie |
|---|---|
| UI | React 19, TypeScript 5, [lucide-react](https://lucide.dev/) (ikony) |
| Framework | [vinext](https://github.com/cloudflare/vinext) – Next.js App Router API nad Vite 8 |
| Styly | Vlastní CSS (`app/globals.css`), Tailwind CSS 4 + PostCSS |
| Výstup | Statický export (`output: "export"`), předrenderování při buildu |
| API | Cloudflare Worker (`worker/`), [ical.js](https://github.com/kewisch/ical.js) |
| Hosting | Cloudflare Workers Static Assets + Worker pro `/api/*` |
| CI/CD | Cloudflare Workers Builds napojené na GitHub |
| Testy | `node:test` (bez dalších závislostí), syntetické `.ics` fixtures |
| Balíčky | pnpm 11 (`pnpm-lock.yaml`), Node.js 24 (`.node-version`) |

## Architektura

```
app/
  layout.tsx            HTML kostra, metadata
  page.tsx              obsah stránky
  globals.css           styly webu včetně kalendáře
components/booking/
  BookingSection.tsx    společný stav pobytu (kalendář + panel), WebMCP nástroj
  AvailabilityCalendar.tsx  navigace, responzivní počet měsíců, klávesnice, legenda, stav dat
  CalendarMonth.tsx     mřížka jednoho měsíce
  BookingPanel.tsx      zelený panel: data, hosté, cena, poptávka
  useAvailability.ts    načítání /api/availability
  config.ts, format.ts  cena, kapacita, české texty a formátování
lib/availability/       sdílená logika (klient i Worker)
  dates.ts              práce s daty YYYY-MM-DD, dnešek v Europe/Prague
  occupancy.ts          obsazené noci, stav dne, slučování intervalů
  stay.ts               jediná validace výběru pobytu
  types.ts              typy odpovědi API
worker/
  index.ts              vstup Workeru: /api/availability, ostatní → statické assety
  availability.ts       stažení exportu, cache, stavy ok / stale / unavailable
  ical.ts               převod iCal na obsazené intervaly
tests/                  unit testy + syntetické fixtures (smyšlené rezervace)
public/                 fotografie, favicon
scripts/finalize-static.mjs   úklid po buildu, ponechá statický výstup
components/ui/, lib/utils.ts, vendor/   knihovna shadcn/ui (zatím nepoužitá)
```

### Build a nasazení Workeru

1. `pnpm run build` sestaví web (vinext) a předrenderuje ho do `dist/client`.
2. `wrangler deploy` nahraje `dist/client` jako statické assety a sbalí Worker
   z `worker/index.ts`.
3. Díky `assets.run_worker_first: ["/api/*"]` se Worker spouští jen pro API.
   Všechny ostatní požadavky obsluhují statické assety přímo.

## Instalace a lokální vývoj

Požadavky: Node.js 24 (viz `.node-version`) a pnpm 11.25 (viz `packageManager`
v `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm dev            # vývojový server Vite (bez /api – kalendář ukáže nedostupnou obsazenost)
pnpm run build      # produkční build do dist/client
pnpm preview        # web i API přes wrangler dev (Workers runtime)
pnpm test           # unit testy parseru, obsazenosti, výběru pobytu a API
```

Pro lokální API zkopírujte `.dev.vars.example` do `.dev.vars` a vyplňte
`ECHALUPY_ICAL_URL`. Soubor `.dev.vars` je v `.gitignore`. Pro vývoj stačí
adresa syntetického `.ics` souboru, soukromý export není potřeba.

## Konfigurace

- **Secret `ECHALUPY_ICAL_URL`:** adresa soukromého iCal exportu z aplikace
  e-chalupy. Nastavuje se jen v Cloudflare (Workers & Pages → `chalupa-vsetice-web`
  → Settings → Variables and Secrets, typ *Secret*) nebo příkazem
  `npx wrangler secret put ECHALUPY_ICAL_URL`. Kontrola bez vyzrazení hodnoty:
  `npx wrangler secret list` (vypíše jen názvy) a `GET /api/availability`
  (`status` je `ok`).
- **`wrangler.jsonc`:** `main: ./worker/index.ts`, assets z `./dist/client`
  s bindingem `ASSETS`, `not_found_handling: "404-page"`,
  `run_worker_first: ["/api/*"]` a blok `previews` pro Worker Previews.
- **`pnpm-workspace.yaml`:**
  - `allowBuilds` povoluje instalační skripty `esbuild` a `workerd`, které pnpm 11
    jinak blokuje.
  - `overrides` fixuje `miniflare>sharp` na verzi 0.35.4.
- **Cena, kapacita a odkaz na poptávku:** `components/booking/config.ts`.

## Nasazení

Nasazení zajišťuje Cloudflare Workers Builds napojené na tento repozitář:

| Nastavení | Hodnota |
|---|---|
| Root directory | `/` |
| Build command | `pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `NODE_VERSION=24.19.0`, `PNPM_VERSION=11.25.0` |

- Push do větve `main` nasadí novou produkční verzi.
- Ostatní větve a pull requesty vytvoří náhledovou verzi (Worker Previews).
- Secret pro Worker Previews se nastavuje zvlášť: `npx wrangler preview secret`.
  Bez něj Preview ukáže obsazenost jako nedostupnou.
