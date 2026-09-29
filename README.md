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

- Worker stahuje soukromý iCal export výhradně metodou GET. Do e-chalup, Airbnb
  ani Booking.com nic nezapisuje a nemá k tomu žádný přístup.
- Adresa exportu je Cloudflare secret `ECHALUPY_ICAL_URL`. Není v repozitáři,
  v klientském kódu ani v odpovědích API a do logů se nikdy nevypisuje.
- Export parsuje knihovna [ical.js](https://github.com/kewisch/ical.js).
  - Celodenní události mají exkluzivní `DTEND`: obsazené jsou noci od příjezdu do
    dne odjezdu.
  - Časované události v UTC nebo s definovaným `VTIMEZONE` se převádějí na data v pásmu
    Europe/Prague. Plovoucí čas (např. `DTSTART:20261002T140000`, formát exportu e-chalup)
    a `TZID` bez definice se berou jako místní čas chalupy.
  - Datum bez `VALUE=DATE` (`DTSTART:20261002`) se přijme jako celodenní.
  - Samostatné události se stejným `UID` se nesloučí, podle `UID` se párují jen výjimky
    opakovaných událostí.
  - Opakované události (`RRULE`, `RECURRENCE-ID`) se rozvinou a zrušené
    (`STATUS:CANCELLED`) se vynechají.
  - Překrývající se a navazující intervaly se sloučí.
  - Den odjezdu jedněch hostů zůstává volný pro příjezd dalších.
- K obsazenosti z exportu se přidávají noci vlastních rezervací z D1 (viz
  [Rezervační backend](#rezervační-backend-cloudflare-d1)).
- API vrací jen obsazené intervaly (data), čas poslední synchronizace a stav.
  Jména, kontakty, popisy, kódy ani UID rezervací se nepředávají.

### Cache a výpadky

| Situace | Chování API (`status`) | Kalendář |
|---|---|---|
| Data mladší než 5 minut | `ok` z cache (paměť izolátu + Cache API) | normální zobrazení |
| Cache vypršela, export dostupný | `ok`, export se stáhne znovu | normální zobrazení |
| Export načtený, ale některé události nešly převést | `partial` (`reason: skipped-events`) | data + upozornění, že obsazenost nemusí být úplná |
| Export nedostupný nebo neplatný, poslední data < 24 h | `stale` | data + upozornění na čas poslední synchronizace; pokud byl záložní snapshot neúplný (`incomplete: true`), výběr je zablokovaný jako u `partial` |
| Vlastní rezervace z D1 nešly načíst | `partial` (`reason: reservations-unavailable`) | jako u `partial`, výběr je zablokovaný |
| Bez použitelných dat nebo bez secretu | `unavailable` | žádný den se netváří jako volný, výběr je zablokovaný, odkaz na e-chalupy |

- Po neúspěšném stažení se další pokus provede nejdřív za minutu.
- Neplatný iCal se nikdy nevyloží jako prázdný kalendář.

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

## Rezervační backend (Cloudflare D1)

Připravená databázová a serverová část budoucí rezervace z webu. Formulář na webu,
platby, e-maily ani výstupní iCal pro e-chalupy zatím neexistují. D1 je jen
technické úložiště, provozní administrací zůstávají e-chalupy.

```
POST /api/reservations → validace → čerstvý export e-chalup → D1 batch (rezervace + VS + noci)
```

### Datový model (`migrations/0001_rezervace.sql`)

- **`reservations`:**
  - interní UUID, veřejný kód (`CV-7K3M9Q`),
  - příjezd, odjezd, počet hostů (CHECK 1–7),
  - jméno, příjmení, telefon, e-mail,
  - cena v Kč, variabilní symbol (UNIQUE),
  - stav a stabilní iCal UID (`rezervace-<uuid>@chalupavsetice.cz`, UNIQUE, spolu s `ical_sequence`),
  - volitelný `idempotency_key` pro opakované odeslání.
- **Stavy:** `pending_payment` (čeká na ruční ověření platby), `paid`, `cancelled`.
  Nezaplacené rezervace se automaticky neruší.
- **`reserved_nights`:** jedna řádka na noc, `night` je PRIMARY KEY. Databáze tak sama
  zabrání tomu, aby dvě rezervace obsadily stejnou noc, i při souběžných požadavcích.
- **`sequences`:** čítač variabilního symbolu. VS = dvojčíslí roku + 6 číslic, např. `26000001`.
- **`meta`:** označení databáze (`environment` = `production` / `preview`), viz Bezpečnost.

### Transakce v D1

Ověřeno v lokálním runtime (Miniflare/workerd) a testy:

- SQL `BEGIN TRANSACTION` / `SAVEPOINT` D1 odmítá. Interaktivní transakce, tedy čtení,
  rozhodnutí v kódu a pak zápis, v D1 neexistuje.
- `db.batch([...])` běží jako jedna transakce: při chybě kteréhokoli příkazu se vrátí celý
  batch.
- Cizí klíče jsou v D1 zapnuté.

Rezervace se proto zakládá jediným batchem:

1. zvýšení čítače VS,
2. vložení rezervace s VS z čítače,
3. vložení všech nocí.

Je-li kterákoli noc obsazená, selže PRIMARY KEY a nevznikne nic: rezervace ani noci, a
VS se nespotřebuje. Kolize se neověřuje dotazem před zápisem, ten by nebyl atomický.

### Postup `POST /api/reservations`

1. Endpoint funguje jen při `BOOKING_API_ENABLED = "true"` (zatím jen Worker Previews)
   a s hlavičkou `Authorization: Bearer <BOOKING_API_TOKEN>`. Jinak vrací 404 jako
   neexistující cesta.
2. Validace (`worker/booking/validation.ts`):
   - datum příjezdu není v minulosti a je nejvýš 365 dní dopředu,
   - 1–30 nocí,
   - 1–7 hostů,
   - jméno, telefon a e-mail bez řídicích znaků.
3. Cena se počítá jen na serveru (`lib/booking/rules.ts`). Hodnota z prohlížeče se
   neukládá. Volitelné `expectedPriceCzk` slouží jen ke kontrole: při nesouladu vrátí
   endpoint 409 `price-mismatch`.
4. Kontrola `meta.environment` = `BOOKING_ENV`. Při nesouladu se nic nezapíše (503).
5. Čerstvé stažení exportu e-chalup (bez cache):
   - selhání vrátí 503 `availability-check-failed`,
   - vynechané události 503 `availability-incomplete`,
   - kolize 409 `dates-unavailable`.
6. Atomický zápis do D1. Kolize nocí vrátí 409, jiná chyba databáze 503 `database-error`.
7. Odpověď 201 obsahuje kód, termín, počet hostů, cenu, VS a stav, ale žádné kontaktní
   údaje. Stejný `Idempotency-Key` se stejným obsahem vrátí původní rezervaci (200).

Logy obsahují jen druh události (`reservations: created`, `rejected (…)`), nikdy osobní
údaje ani adresu exportu.

### Vlastní rezervace vrácená exportem e-chalup

Až e-chalupy naimportují rezervaci z webu, objeví se v jejich exportu. Při kontrole
existující rezervace (`findExternalConflict(…, exclude)`) se taková událost nepovažuje
za kolizi se sebou samotnou, pokud nese stejné iCal UID nebo veřejný kód rezervace v
`SUMMARY`/`DESCRIPTION`.

Pro novou rezervaci je každá událost exportu obsazený termín, tedy i ozvěna jiné vlastní
rezervace. Shoda samotného termínu nestačí, jinak by se skryla cizí rezervace se stejnými
daty.

### Bezpečnost prostředí

- Produkce a Worker Previews mají **oddělené databáze**:
  - `chalupa-vsetice-rezervace` pro produkci,
  - `chalupa-vsetice-rezervace-test` pro Preview.
  Previews nedědí bindingy ani proměnné z produkce a mají je v bloku `previews` ve
  `wrangler.jsonc`.
- Pojistka proti záměně: Worker zapisuje jen do databáze, jejíž `meta.environment` se
  shoduje s `BOOKING_ENV`:
  - produkce: `production`,
  - Preview: `preview`.
- V produkci je `POST /api/reservations` vypnutý (`BOOKING_API_ENABLED` není nastavené).
  `/api/availability` z produkční D1 jen čte.
- Testy používají výhradně smyšlené rezervace a lokální D1.
- **Budoucí veřejný formulář:** `BOOKING_API_TOKEN` chrání jen testovací endpoint v
  Preview a nesmí se dostat do klientského JavaScriptu. Veřejný POST nepoužije sdílený
  Bearer token, ale potřebuje ochranu proti spamu a zneužití: Cloudflare Turnstile
  s ověřením tokenu na serveru a rate limiting.

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
lib/booking/            pravidla pobytu a ceny, veřejný kód a iCal UID rezervace
lib/availability/       sdílená logika (klient i Worker)
  dates.ts              práce s daty YYYY-MM-DD, dnešek v Europe/Prague
  occupancy.ts          obsazené noci, stav dne, slučování intervalů
  stay.ts               jediná validace výběru pobytu
  types.ts              typy odpovědi API
worker/
  index.ts              vstup Workeru: /api/availability, ostatní → statické assety
  availability.ts       stažení exportu, cache, stavy ok / stale / unavailable
  ical.ts               převod iCal na obsazené intervaly a události (UID, kódy rezervací)
  http.ts               JSON odpovědi s bezpečnostními hlavičkami
  booking/
    handler.ts          POST /api/reservations
    validation.ts       serverová validace termínu, kapacity, kontaktů a ceny
    external.ts         čerstvá kontrola proti exportu e-chalup, rozpoznání vlastní rezervace
    db.ts               D1: atomické založení rezervace, obsazené noci
migrations/             SQL migrace D1
tests/                  unit testy + syntetické fixtures (smyšlené rezervace), lokální D1 (Miniflare)
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
pnpm test           # testy parseru, obsazenosti, výběru pobytu, API a D1 (lokální Miniflare)
```

Pro lokální API zkopírujte `.dev.vars.example` do `.dev.vars` a vyplňte
`ECHALUPY_ICAL_URL`. Soubor `.dev.vars` je v `.gitignore`. Pro vývoj stačí
adresa syntetického `.ics` souboru, soukromý export není potřeba.

Lokální D1 (jen na vašem počítači, nikdy `--remote`):

```bash
npx wrangler d1 migrations apply chalupa-vsetice-rezervace --local
npx wrangler d1 execute chalupa-vsetice-rezervace --local \
  --command "INSERT INTO meta (key, value) VALUES ('environment', 'local')"
```

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
- **D1:** binding `DB` (produkce: `chalupa-vsetice-rezervace`; `previews`:
  `chalupa-vsetice-rezervace-test`), migrace v `migrations/`.
- **Proměnné rezervací:**
  - `BOOKING_ENV` (`production` / `preview`),
  - `BOOKING_API_ENABLED` (jen `previews`),
  - secret `BOOKING_API_TOKEN` (jen Preview).
- **Cena a kapacita:** `lib/booking/rules.ts`. Odkaz na poptávku: `components/booking/config.ts`.

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
- Migrace D1 se při buildu nespouštějí. Spouštějí se ručně, nejdřív na testovací
  databázi. `d1 migrations apply` a `d1 execute` čtou jen top-level `d1_databases`
  (ne blok `previews`), testovací databáze je proto i v `preview_database_id`:

  ```bash
  # Preview / test (--preview = preview_database_id)
  npx wrangler d1 migrations apply chalupa-vsetice-rezervace --remote --preview
  # Produkce
  npx wrangler d1 migrations apply chalupa-vsetice-rezervace --remote
  ```
