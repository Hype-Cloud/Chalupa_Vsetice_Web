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

Aktuální zákaznické rezervace se stále přijímají přes **e-chalupy**. Ta jsou
centrálním kalendářem a synchronizují obsazenost s Airbnb a Booking.com. Web jejich
obsazenost čte a zároveň má připravený vlastní rezervační backend; rezervace uložené
v D1 se exportují zpět do e-chalup přes soukromý iCal feed:

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
  [Rezervační backend](#rezervační-backend--technický-popis)).
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

## Rezervační backend nad Cloudflare D1

Backend pro budoucí přímé rezervace prostřednictvím webu Chalupa Všetice. Databáze D1 slouží jako technické úložiště rezervací a zajišťuje okamžitou blokaci obsazených termínů. Provozní administrací zůstávají e-chalupy.

### Implementované funkce

- Databázové tabulky pro rezervace, obsazené noci, variabilní symboly a konfiguraci prostředí.
- Atomické vytvoření rezervace prostřednictvím D1 batch transakce.
- Databázová ochrana proti dvojité rezervaci pomocí unikátního záznamu každé obsazené noci.
- Serverová validace termínů, kapacity a kontaktních údajů.
- Serverový ceník v D1: výchozí cena za noc, vlastní ceny konkrétních nocí a množstevní slevy podle délky pobytu; cenová nabídka `POST /api/quote`.
- Kontrola aktuální obsazenosti proti externímu iCal exportu před vytvořením rezervace.
- Odmítnutí rezervace při nedostupném nebo neúplném exportu.
- Podpora Idempotency-Key proti nechtěnému opakovanému vytvoření rezervace.
- Okamžité promítnutí vlastních rezervací z D1 do veřejného kalendáře.
- Rozpoznání vlastní rezervace vrácené externím kalendářem podle stabilního UID nebo veřejného kódu.
- Oddělené databáze pro produkční a testovací prostředí.
- Kontrola prostředí prostřednictvím meta.environment.
- Cloudflare Observability: Logs a Traces s oddělenou konfigurací produkčního a testovacího prostředí.

Produkční endpoint pro vytváření rezervací zůstává vypnutý. Testovací endpoint je chráněn autentizací a slouží výhradně k vývojovým účelům.

## Automatické testování

Projekt využívá Node.js Test Runner. Databázové testy probíhají nad lokální Cloudflare D1 prostřednictvím Miniflare/workerd. Testovací údaje jsou syntetické.

**Výsledek posledního vývojového běhu: 185/185 úspěšných testů.**

| Testovací soubor | Počet | Zaměření |
|---|---:|---|
| ical.test.ts | 20 | Parsování iCalendar, časová pásma, opakované a zrušené události, chybné exporty. |
| availability.test.ts | 21 | Načítání obsazenosti, cache, výpadky externí služby a neúplná data. |
| occupancy.test.ts | 15 | Slučování obsazených intervalů, kontrola termínů a chování kalendáře. |
| booking.test.ts | 9 | Validace rezervací, ceny, kontakty, vlastní iCal UID a propojení D1 s kalendářem. |
| reservations-api.test.ts | 17 | Rezervační API, autorizace, idempotence, souběh požadavků a chybové stavy. |
| reservations-db.test.ts | 19 | Databázová omezení, atomické transakce, rollback a ochrana proti kolizím. |
| ical-export.test.ts | 19 | Výstupní iCal: formát RFC 5545, escaping, stabilita UID, zrušení (STATUS:CANCELLED), autorizace, chyby D1 a prostředí, únik osobních údajů. |
| conflicts.test.ts | 18 | Detekce kolizí během zpoždění synchronizace: překryvy a hranice, ozvěny, idempotence, souběh, úplný/neúplný snapshot, výpadek e-chalup, upozornění. |
| conflict-cron.test.ts | 12 | Cron detekce a e-mailové upozornění: odeslání a notified_at, žádný druhý e-mail, retry po chybě providera, nesoulad prostředí, výpadek a neúplný export, souběh s /api/availability, bez osobních údajů. |
| booking-public.test.ts | 16 | Veřejný POST: Turnstile (platný, neplatný, chybějící, nedostupný), rate limit, idempotentní retry a dvojklik, chybové kódy, bez úniku osobních údajů a secrets. |
| pricing.test.ts | 19 | Ceník: výchozí a vlastní ceny nocí, prahy slev, zaokrouhlení, přelom měsíce a roku, `/api/quote` (kontrakt, validace, neplatný ceník, výpadek D1, žádné zápisy), shoda ceny nabídky a rezervace, `price-mismatch`. |
| **Celkem** | **185** | |

### Testované scénáře

- Úspěšné vytvoření rezervace a přidělení variabilního symbolu.
- Souběžné vytváření 20 rezervací stejného termínu – uspěje pouze jedna.
- Odmítnutí úplných i částečných překryvů rezervací.
- Povolení navazujících pobytů se společným dnem příjezdu a odjezdu.
- Atomické vrácení neúspěšné transakce včetně čítače variabilních symbolů.
- Kontrola unikátnosti veřejných kódů, UID a idempotency klíčů.
- Opakované a souběžné odeslání identického požadavku.
- Odmítnutí neplatných osobních údajů, termínů a kapacity.
- Výpočet ceny výhradně na serveru jedním výpočtem pro nabídku i rezervaci.
- Odmítnutí výpočtu při neplatných ceníkových datech (bez tichého návratu k výchozí ceně).
- Odmítnutí rezervace při výpadku databáze nebo externího kalendáře.
- Odmítnutí rezervace při neúplných datech z externího kalendáře.
- Zamezení zápisu do databáze nesprávného prostředí.
- Vypnutý rezervační endpoint v produkčním prostředí.
- Okamžité přidání rezervace do obsazenosti kalendáře.
- Přepnutí kalendáře do bezpečného režimu při výpadku D1.
- Kontrola, že API obsazenosti nevrací osobní údaje hostů.

## Ruční integrační testování

Vedle automatických testů proběhly integrační testy na skutečné infrastruktuře Cloudflare Workers a vzdálené testovací D1.

### 1. Databáze a infrastruktura

- Úspěšné vytvoření oddělené produkční a testovací D1.
- Úspěšné provedení databázové migrace v obou prostředích.
- Ověření správného environment markeru.
- Kontrola počátečního stavu databází.
- Úspěšný Cloudflare Workers Preview build.
- Ověření dostupnosti potřebných Preview secrets bez zveřejnění jejich hodnot.

### 2. API a autorizace

- GET /api/availability správně vrací aktuální obsazenost.
- Export e-chalup je načten bez chybných nebo vynechaných událostí.
- POST /api/reservations bez přístupového tokenu je odmítnut (HTTP 401).
- Autorizovaný POST se syntetickými údaji úspěšně vytvořil rezervaci (HTTP 201).
- Rezervace dostala veřejný kód, variabilní symbol, správnou cenu a stav pending_payment.

### 3. Okamžitá synchronizace kalendáře

- Nově vytvořená rezervace se okamžitě objevila v GET /api/availability.
- Existující rezervace z e-chalup zůstaly zachované.
- Obsazenost byla vizuálně ověřena také na testovací verzi webu.
- Změna nevyžadovala čekání na synchronizaci e-chalup.

### 4. Ochrana proti dvojité rezervaci

- Druhý požadavek na již rezervovaný termín byl odmítnut (HTTP 409).
- Následná kontrola D1 potvrdila jedinou vytvořenou rezervaci.
- Počet obsazených nocí odpovídal původní rezervaci.
- Neúspěšný požadavek nespotřeboval další variabilní symbol.

### 5. Idempotence

- Opakované odeslání původního požadavku se stejným Idempotency-Key vrátilo původní rezervaci.
- API správně nastavilo replayed: true.
- Veřejný kód a variabilní symbol zůstaly nezměněné.
- Nevznikla žádná duplicitní rezervace.

## Integrační testy e-chalup

Na syntetickém iCalendar feedu byla ověřena také zpětná integrace s e-chalupami:

- Import nové rezervace z externího ICS.
- Vytvoření editovatelné rezervace v administraci e-chalup.
- Přenos doplňujících informací prostřednictvím DESCRIPTION.
- Zachování UID rezervace při zpětném exportu obsazenosti.
- Zahrnutí importované rezervace do exportovaného kalendáře.
- Pouhé odstranění VEVENT z feedu importovanou rezervaci nezrušilo.
- Zrušení bylo úspěšně ověřeno pomocí stejného UID, vyššího SEQUENCE a STATUS:CANCELLED.

Aktualizace poznámky již importované rezervace nebyla spolehlivě potvrzena. Budoucí implementace na této funkcionalitě nezávisí.

## Stav nasazení

- Testovací D1: připravená, integrační testy úspěšné.
- Produkční D1: migrace úspěšně provedena, databáze připravená a bez rezervací.
- Produkční rezervační POST: vypnutý.
- Výstupní iCal `/api/reservations.ics`: zapnutý v produkci i ve Worker Previews a připojený k importu v e-chalupách. Celý tok (import, zrušení přes `STATUS:CANCELLED`) je ověřený na produkci syntetickou rezervací, která byla následně odstraněna.
- Stávající způsob poptávky prostřednictvím e-chalup: zachován.

## Navazující vývoj

Dosud nejsou implementovány:

- Veřejný rezervační formulář.
- Napojení kalendáře na webu na `POST /api/quote` (zatím zobrazuje orientační výchozí cenu).
- Generování platebních QR kódů.
- Automatické odesílání e-mailových oznámení.

Před veřejným spuštěním rezervačního systému proběhne také závěrečná kontrola oprávnění, přístupových údajů, starých testovacích deploymentů a nastavení diagnostických záznamů.

## Rezervační backend – technický popis

Připravená databázová a serverová část budoucí rezervace z webu. Formulář na webu,
platby a e-maily zatím neexistují. Výstupní iCal pro e-chalupy je implementovaný
a aktivní v produkci. D1 je jen
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

1. Endpoint funguje jen při `BOOKING_API_ENABLED = "true"` (zatím jen Worker Previews),
   jinak vrací 404 jako neexistující cesta. Pokud je nastavený `BOOKING_API_TOKEN` (jen neveřejné
   prostředí), vyžaduje navíc `Authorization: Bearer <token>`.
   - **Rate limit** (Workers Rate Limiting binding `BOOKING_RATE_LIMITER`, `ratelimits` ve
     `wrangler.jsonc`): 5 požadavků za 60 s na IP (`CF-Connecting-IP`) v rámci lokality Cloudflare,
     mimo paměť izolátu, sdílený všemi instancemi Workeru. Překročení = 429 `rate-limited`
     s `Retry-After: 60`; selhání limiteru = 503 (fail-closed). Produkce a Preview mají oddělené
     namespace. Zvolen jako nejjednodušší varianta bez další infrastruktury (žádná KV, D1 ani Durable
     Object kvůli počítání). Chrání proti spamu; dvojí rezervaci téže noci brání D1, ne rate limit.
   - **Turnstile:** tělo požadavku nese `turnstileToken` (token z widgetu). Worker ho ověří přes
     Siteverify s `TURNSTILE_SECRET_KEY` (a IP hosta). Chybějící token = 400 `turnstile-required`,
     neplatný = 403 `turnstile-failed`, nedostupné Siteverify nebo chybný secret = 503
     `turnstile-unavailable` (fail-closed). Token ani odpověď Siteverify se nelogují.
     V produkci se testovací secret Cloudflare odmítne (503 `not-configured`).
2. Validace (`worker/booking/validation.ts`):
   - datum příjezdu není v minulosti a je nejvýš 365 dní dopředu,
   - 1–30 nocí,
   - 1–7 hostů,
   - jméno, telefon a e-mail bez řídicích znaků.
3. Cena se počítá jen na serveru stejným výpočtem jako `POST /api/quote`
   (`worker/booking/pricing.ts`, viz [Ceník](#ceník-a-cenová-nabídka)) – po ověření Turnstile.
   Hodnota z prohlížeče se neukládá. Volitelné `expectedPriceCzk` (frontend posílá `totalCzk`
   z `/api/quote`) slouží jen ke kontrole: při nesouladu vrátí endpoint 409 `price-mismatch`
   s aktuální cenou. Neplatná ceníková data v D1 = 503 `pricing-unavailable`.
4. Kontrola `meta.environment` = `BOOKING_ENV`. Při nesouladu se nic nezapíše (503).
5. Čerstvé stažení exportu e-chalup (bez cache):
   - selhání vrátí 503 `availability-check-failed`,
   - vynechané události 503 `availability-incomplete`,
   - kolize 409 `dates-unavailable`.
6. Atomický zápis do D1. Kolize nocí vrátí 409, jiná chyba databáze 503 `database-error`.
7. Odpověď 201 obsahuje kód, termín, počet hostů, cenu, VS a stav, ale žádné kontaktní
   údaje. Stejný `Idempotency-Key` se stejným obsahem vrátí původní rezervaci (200,
   `replayed: true`) – ještě před ověřením Turnstile, protože token je jednorázový. Siteverify
   dostává `idempotency_key` odvozený z `Idempotency-Key`, takže souběžný dvojklik se stejným
   klíčem a tokenem skončí jednou rezervací. Bez klíče druhý požadavek odmítne Turnstile
   (použitý token) nebo D1 (obsazené noci). Frontend má posílat náhodný `Idempotency-Key`
   (16–100 znaků `A–Z a–z 0–9 _ -`) jednou na odeslání formuláře; klíč nesmí obsahovat osobní údaje.

#### Chybové kódy (`{ "error": "<kód>" }`)

| HTTP | `error` | Význam pro frontend |
|---|---|---|
| 400 | `invalid-json`, `invalid-idempotency-key` | chybný požadavek (chyba klienta) |
| 413 / 415 | `payload-too-large` / `unsupported-media-type` | chybný požadavek |
| 422 | `invalid-request` (+ `fields`: názvy chybných polí, bez hodnot) | neplatné údaje ve formuláři |
| 422 | `idempotency-key-reused` | stejný klíč s jiným obsahem – vygenerovat nový klíč |
| 400 | `turnstile-required` | chybí ověření Turnstile |
| 403 | `turnstile-failed` | ověření Turnstile neprošlo – obnovit widget a odeslat znovu |
| 429 | `rate-limited` | příliš mnoho pokusů, `Retry-After` v sekundách |
| 409 | `dates-unavailable` | termín je obsazený |
| 409 | `price-mismatch` (+ `priceCzk`) | cena se změnila – zobrazit novou cenu |
| 503 | `availability-check-failed`, `availability-incomplete` | dostupnost teď nejde bezpečně ověřit – zkusit později |
| 503 | `pricing-unavailable` | ceník v D1 je neplatný – cenu teď nejde spočítat |
| 503 | `turnstile-unavailable` | ověření Turnstile je dočasně nedostupné – zkusit později |
| 503 | `not-configured`, `service-unavailable`, `database-environment-mismatch`, `database-error` | interní chyba / výpadek |
| 500 | `internal-error` | neočekávaná interní chyba |
| 404 / 405 | `not-found` / `method-not-allowed` | endpoint vypnutý / jiná metoda |

Odpovědi nikdy neobsahují stack trace, secrets, adresu exportu ani detaily databáze.

Logy obsahují jen druh události (`reservations: created`, `rejected (…)`), nikdy osobní
údaje ani adresu exportu.

### Ceník a cenová nabídka

Ceník žije v D1 (`migrations/0005_ceny.sql`) a spravuje se zatím jen přes Wrangler CLI –
bez administrace a bez API pro zápis. Jediný výpočet ceny je `worker/booking/pricing.ts`;
používá ho `POST /api/quote` i `POST /api/reservations`.

```sql
daily_prices     (date TEXT PRIMARY KEY 'YYYY-MM-DD', price_czk INTEGER 1–1 000 000)
length_discounts (id, min_nights INTEGER UNIQUE >= 1, discount_percent INTEGER 0–100)
```

**Algoritmus** (vše v celých Kč):

1. Pro každou noc pobytu (od příjezdu včetně do odjezdu bez noci odjezdu) se vezme
   `daily_prices.price_czk`, jinak výchozí cena `PRICE_PER_NIGHT` (3 000 Kč, `lib/booking/rules.ts`).
2. `subtotalCzk` = součet cen nocí.
3. Sleva: pravidlo s nejvyšším `min_nights`, které je ≤ počtu nocí. Žádné pravidlo = bez slevy.
   Slevy se nesčítají.
4. **Zaokrouhlení:** `amountCzk = floor(subtotalCzk × percent / 100)` – sleva se zaokrouhluje
   dolů na celé Kč (host nikdy nedostane víc slevy, než odpovídá procentu).
   `totalCzk = subtotalCzk − amountCzk`. Příklad: 23 331 Kč × 5 % = 1 166,55 → sleva 1 166 Kč,
   celkem 22 165 Kč.
5. Neplatná data v ceníku (nečíselná nebo nekladná cena, procento mimo 0–100, duplicitní práh)
   = výpočet se odmítne (503 `pricing-unavailable`), nikdy tichý návrat k výchozí ceně.
   Databázová omezení taková data běžně nepustí; kontrola ve Workeru je pojistka.

Ceník neřeší dostupnost – tu dál ověřuje `/api/availability` a při rezervaci čerstvý export e-chalup.
Bez slev podle počtu hostů, promo kódů a sezónních pravidel (sezónu lze vyjádřit cenami jednotlivých nocí).

#### `POST /api/quote`

Požadavek (`Content-Type: application/json`, max. 2 KB):

```json
{ "arrivalDate": "2030-12-07", "departureDate": "2030-12-17", "guests": 2 }
```

Odpověď 200 (`Cache-Control: no-store`):

```json
{
  "arrivalDate": "2030-12-07",
  "departureDate": "2030-12-17",
  "nights": 10,
  "subtotalCzk": 30000,
  "discount": { "type": "length", "minNights": 7, "percent": 5, "amountCzk": 1500 },
  "totalCzk": 28500,
  "nightlyPrices": [{ "date": "2030-12-07", "priceCzk": 3000 }, "…"]
}
```

`discount` je `null`, když se žádná sleva neuplatní. Validace termínu a počtu hostů je stejná
jako u rezervace (minulost, horizont 365 dní, 1–30 nocí, 1–7 hostů); chyba = 422 `invalid-request`
s `fields` (`arrivalDate`, `departureDate`, `guests`). Další chyby: 400 `invalid-json`,
405, 413, 415, 503 `pricing-unavailable` / `database-error` / `not-configured`, 500 `internal-error`.
Endpoint jen čte (žádný zápis do D1), neobsahuje osobní údaje a je dostupný i v produkci.
Cena z nabídky není závazná: rezervace ji spočítá znovu a při změně ceníku vrátí 409 `price-mismatch`.

#### Správa ceníku přes CLI

Příkazy pro testovací D1 (Preview) používají `--config wrangler.preview-migrations.jsonc`,
pro produkci výchozí `wrangler.jsonc`. Změna platí okamžitě pro nové nabídky i rezervace;
už založené rezervace si svou cenu ponechávají.

```bash
# Testovací D1 (Preview)
npx wrangler d1 execute chalupa-vsetice-rezervace-test --remote --config wrangler.preview-migrations.jsonc \
  --command "INSERT INTO daily_prices (date, price_czk) VALUES ('2026-12-24', 4500), ('2026-12-31', 6000) ON CONFLICT(date) DO UPDATE SET price_czk = excluded.price_czk;"

# Produkce – vlastní cena noci (vložení nebo změna)
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "INSERT INTO daily_prices (date, price_czk) VALUES ('2026-12-31', 6000) ON CONFLICT(date) DO UPDATE SET price_czk = excluded.price_czk;"

# Návrat noci k výchozí ceně
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "DELETE FROM daily_prices WHERE date = '2026-12-31';"

# Množstevní sleva (od 7 nocí 5 %), změna existujícího prahu
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "INSERT INTO length_discounts (min_nights, discount_percent) VALUES (7, 5) ON CONFLICT(min_nights) DO UPDATE SET discount_percent = excluded.discount_percent;"

# Zrušení slevy
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "DELETE FROM length_discounts WHERE min_nights = 7;"

# Kontrola ceníku
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "SELECT * FROM daily_prices ORDER BY date; SELECT * FROM length_discounts ORDER BY min_nights;"
```

Cenu konkrétního termínu ověří `POST /api/quote`. Výchozí cena za noc je v kódu
(`PRICE_PER_NIGHT`) – její změna znamená nový deploy; frontend ji zatím zobrazuje jen orientačně.

### Vlastní rezervace vrácená exportem e-chalup

Až e-chalupy naimportují rezervaci z webu, objeví se v jejich exportu. Při kontrole
existující rezervace (`findExternalConflict(…, exclude)`) se taková událost nepovažuje
za kolizi se sebou samotnou, pokud nese stejné iCal UID nebo veřejný kód rezervace v
`SUMMARY`/`DESCRIPTION`.

Pro novou rezervaci je každá událost exportu obsazený termín, tedy i ozvěna jiné vlastní
rezervace. Shoda samotného termínu nestačí, jinak by se skryla cizí rezervace se stejnými
daty.

### Kolize během zpoždění synchronizace

Rezervace z webu se před uložením ověří proti čerstvému exportu e-chalup. Airbnb nebo Booking.com
ale mohou stejný termín prodat dřív, než se jejich rezervace v exportu e-chalup objeví. Této
situaci nejde zabránit, jen ji rychle odhalit (`worker/booking/conflicts.ts`):

- **Kdy:**
  - **Cron Trigger každých 5 minut** (`triggers.crons` ve `wrangler.jsonc`, `worker/booking/cron.ts`),
    nezávisle na návštěvě webu: ověří prostředí D1, stáhne čerstvý export (stejná funkce
    `fetchFreshExternalSnapshot` a parser jako `/api/availability`), spustí detekci a odešle
    čekající upozornění.
  - navíc po každém čerstvém stažení exportu v `GET /api/availability` (nejvýš jednou za 5 minut
    díky cache), odloženě přes `ctx.waitUntil`. Odpověď kalendáře na detekci nečeká a její chyba
    ho neovlivní. Obě cesty můžou běžet souběžně (UNIQUE index a `last_seen_at`).
- **Co:** nezrušené vlastní rezervace celé ležící v rozsahu exportu se porovnají s jednotlivými
  událostmi exportu. Ozvěna vlastní rezervace (stejné UID nebo kód) se ignoruje. Kolize =
  společná noc; navazující pobyty kolizí nejsou.
- **Kde:** tabulka `reservation_conflicts` (migrace 0004), oddělená od platebního stavu
  rezervace. Nejvýš jedna aktivní kolize na dvojici rezervace × otisk cizí události (SHA-256 z UID,
  u výskytu opakované události UID + RECURRENCE-ID, bez UID z kolidujících nocí), zajištěno
  částečným UNIQUE indexem i při souběžných bězích.
  Opakovaná detekce jen aktualizuje `last_seen_at`.
- **Vyřešení:** jen z úplného exportu (žádná vynechaná událost), ve kterém už kolize není.
  Výpadek e-chalup (`stale`/`unavailable`) detekci nespustí, neúplný export (`partial`) kolize
  jen přidává. Zrušená vlastní rezervace kolizi uzavře. Vyřešené kolize zůstávají v historii.
- **Nic se automaticky neruší** – kolizi řeší majitel ručně v e-chalupách.
- **Upozornění e-mailem** (`worker/booking/alerts.ts`, jen Cron): na každou trvající kolizi s
  `notified_at IS NULL` přijde správci interní e-mail `POZOR: kolize rezervace CV-XXXXXX` s kódem
  rezervace, kolidujícím termínem a časem zjištění – bez jména, kontaktů hosta, cizího UID
  a adresy exportu. Mimo produkci s prefixem `[TEST]`.
  - `notified_at` se nastaví až po úspěšné odpovědi providera. Při chybě zůstane NULL a další Cron
    to zkusí znovu (at-least-once); trvající kolize další e-mail nevyvolá.
  - Duplicity při souběhu nebo opakování potlačuje `Idempotency-Key: conflict-alert-<BOOKING_ENV>-<id>`
    (Resend ho drží 24 h).
  - Provider: [Resend](https://resend.com) přes jeden `fetch` POST, bez SDK.
- **Nastavení e-mailu** (Cloudflare secrets, nikdy v repozitáři):

  ```bash
  npx wrangler secret put RESEND_API_KEY          # API klíč Resend (oprávnění Sending access)
  npx wrangler secret put CONFLICT_ALERT_EMAIL    # adresa správce, kam chodí upozornění
  npx wrangler secret put CONFLICT_ALERT_FROM     # doporučeno: Chalupa Všetice <admin@chalupavsetice.cz>
  ```

  - `CONFLICT_ALERT_EMAIL` je secret, ne `vars`: je to osobní adresa a repozitář je veřejný.
  - Produkční odesílatel: `Chalupa Všetice <admin@chalupavsetice.cz>` (doména `chalupavsetice.cz`
    je v Resend ověřená). `admin@chalupavsetice.cz` je interní provozní adresa pro správce a alerty,
    ne veřejná adresa pro hosty.
  - Bez `CONFLICT_ALERT_FROM` se použije testovací odesílatel Resend `onboarding@resend.dev`, který
    doručí jen na e-mail účtu Resend.
  - Bez `RESEND_API_KEY` nebo `CONFLICT_ALERT_EMAIL` se nic neodesílá a log hlásí
    `conflicts-mail: not configured (N pending)`.
- **Logy:** jen `conflicts-cron: N new, M active`, `conflicts-cron: upstream unavailable (…)`,
  `conflicts-cron: incomplete snapshot`, `conflicts-cron: database environment mismatch`,
  `conflicts-mail: N sent`, `conflicts-mail: send failed (…)`.
- **Kontrola v D1** (trvající kolize; `notified_at` prázdné = upozornění ještě neodešlo):

  ```bash
  npx wrangler d1 execute chalupa-vsetice-rezervace --remote --command "SELECT r.public_code, c.conflict_start, c.conflict_end, c.detected_at, c.last_seen_at, c.notified_at FROM reservation_conflicts c JOIN reservations r ON r.id = c.reservation_id WHERE c.resolved_at IS NULL"
  ```
- Cron Trigger běží jen u produkčního Workeru, Worker Previews ho nespouštějí.

### Výstupní iCal pro e-chalupy (`GET /api/reservations.ics`)

Soukromý iCal feed vlastních rezervací z D1, určený k automatickému importu do e-chalup přes URL:

```
D1 (reservations) → GET /api/reservations.ics?token=… → import v e-chalupách
```

- **Jen rezervace z D1.** Export nikdy nečte ani nepřebírá události z exportu e-chalup, takže
  nevzniká synchronizační smyčka. Rezervace, kterou e-chalupy vrátí ve svém exportu,
  se na webu rozpozná podle UID.
- **Formát (RFC 5545):**
  - UTF-8, CRLF, řádky zalomené na 75 oktetů bez dělení vícebajtových znaků,
  - escapování `\ ; ,` a konců řádků.
- **Každá rezervace = jedna celodenní událost:**
  - stabilní `UID` (`rezervace-<uuid>@chalupavsetice.cz`),
  - `DTSTART;VALUE=DATE` = příjezd, exkluzivní `DTEND;VALUE=DATE` = den odjezdu, bez časového pásma,
  - `DTSTAMP` a `LAST-MODIFIED` = poslední změna rezervace, takže nezměněná rezervace dává
    stále stejný text; dále `SEQUENCE`,
  - `SUMMARY` `Web CV-XXXXXX – Jméno Příjmení`,
  - `DESCRIPTION` s kódem rezervace, hostem, telefonem, e-mailem, počtem hostů, cenou, VS
    a stavem platby. Tyto údaje se do e-chalup přenesou v poznámce rezervace (ověřeno
    testem importu).
- **Zrušené rezervace** (`cancelled`) zůstávají ve feedu jako „tombstone“: stejné `UID`,
  aktuální (zvýšené) `SEQUENCE`, původní `DTSTART`/`DTEND` a `STATUS:CANCELLED`, bez osobních
  a platebních údajů. Podle ověřeného chování e-chalupy rezervaci zruší právě takto; pouhé
  vynechání události ji **nezruší**. `SEQUENCE` a čas změny zvyšuje `cancelReservation()`;
  při ručním `UPDATE` stavu (např. `wrangler d1 execute`) je doplní trigger z migrace 0003,
  bez dvojího navýšení. Aktivní rezervace mají
  `STATUS:CONFIRMED`.
- **Mimo produkci** mají název kalendáře, `SUMMARY` i `DESCRIPTION` prefix `[TEST]`.
- **Chyby:**
  - chyba D1 nebo nesoulad `meta.environment` s `BOOKING_ENV` vrátí 503 (`text/plain`)
    bez kalendáře. Importér tak nedostane prázdný ani neúplný VCALENDAR, podle kterého
    by rezervace zrušil,
  - neplatný záznam zastaví celý export, nikdy se nevynechá.
- **Hlavičky:** `text/calendar; charset=utf-8`, `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex`.

**Přístup a secrets:**
- Export je zapnutý jen při `BOOKING_ICAL_EXPORT_ENABLED = "true"`. Je nastavené v top-level
  `vars` (produkce) i v bloku `previews` ve `wrangler.jsonc`; bez něj vrací 404.
- Token je secret `BOOKING_ICAL_EXPORT_TOKEN`, nejméně 32 znaků (doporučeno
  `openssl rand -hex 32`). Kratší nebo chybějící token znamená 503.
- Token je v **query stringu** (`?token=`), ne v cestě. Worker Logs i Traces mají
  `observability.redact_query_string: true`, takže se URL s tokenem v Cloudflare
  Observability neukládá.
- Kód Workeru token, URL ani osobní údaje neloguje; loguje jen `ical-export: served (N events)`,
  `unauthorized`, `failed` apod.
- Chybný nebo chybějící token vrací 404, aby šlo existenci feedu ověřit jen se správným tokenem.
  Token se porovnává v konstantním čase.
- Hlavička `Authorization` se nepoužívá, importéry ICS umí jen URL.
- **Celá URL feedu je secret:** nesdílet, nevkládat do repozitáře, tiketů ani screenshotů.
  Při podezření na únik vygenerovat nový token a URL v e-chalupách vyměnit.

#### Bezpečný postup nasazení exportu

1. **Preview:**
   - nastavit `npx wrangler preview base-config secret put BOOKING_ICAL_EXPORT_TOKEN`,
   - ověřit feed na Preview URL: 200, `[TEST]` prefix, platný iCal,
   - **nepřidávat ho do živých e-chalup.** Testovací D1 obsahuje syntetickou rezervaci.
2. **Test importu:** feed Preview případně vyzkoušet jen na izolovaném importu a
   po testu import v e-chalupách smazat.
3. **Produkce (provedeno):**
   - nastavit produkční secret `npx wrangler secret put BOOKING_ICAL_EXPORT_TOKEN`
     (jiný token než v Preview),
   - v PR přidat `BOOKING_ICAL_EXPORT_ENABLED = "true"` do top-level `vars`,
   - po nasazení ověřit, že produkční D1 obsahuje jen skutečné rezervace (žádné testovací),
   - teprve potom zadat URL do importu e-chalup.
4. **Vypnutí:** export odstraněním `BOOKING_ICAL_EXPORT_ENABLED` vypnete. Import
   v e-chalupách nejdřív odpojte, jinak bude hlásit chybu importu.
5. **Výměna tokenu** (např. po úniku URL): `openssl rand -hex 32`,
   `npx wrangler secret put BOOKING_ICAL_EXPORT_TOKEN` a novou adresu zadat do importu
   v e-chalupách. Starý token přestane platit okamžitě.

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
- **Veřejný formulář:** `BOOKING_API_TOKEN` je volitelná pojistka jen pro neveřejné prostředí
  a nesmí se dostat do klientského JavaScriptu. Veřejný POST chrání Turnstile a rate limit.
- **Testování Preview / lokálně bez oslabení produkce:** Turnstile se ověřuje vždy (žádný bypass
  v kódu). Preview a lokální vývoj používají testovací klíče Cloudflare: secret
  `1x0000000000000000000000000000000AA` (vždy projde) s testovacím tokenem
  `XXXX.DUMMY.TOKEN.XXXX`, popř. `2x…AA` (vždy selže). Produkce testovací secret odmítne.

  ```bash
  # Preview (testovací secret Cloudflare)
  npx wrangler preview base-config secret put TURNSTILE_SECRET_KEY
  # Produkce (skutečný secret z Cloudflare Turnstile widgetu, až se bude zapínat POST)
  npx wrangler secret put TURNSTILE_SECRET_KEY
  ```

  Site key widgetu je veřejný a doplní ho až frontend formuláře.

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
lib/booking/            pravidla pobytu, výchozí cena za noc, veřejný kód a iCal UID rezervace
lib/availability/       sdílená logika (klient i Worker)
  dates.ts              práce s daty YYYY-MM-DD, dnešek v Europe/Prague
  occupancy.ts          obsazené noci, stav dne, slučování intervalů
  stay.ts               jediná validace výběru pobytu
  types.ts              typy odpovědi API
worker/
  index.ts              vstup Workeru: /api/availability, /api/quote, /api/reservations, /api/reservations.ics; ostatní → statické assety
  availability.ts       stažení exportu, cache, stavy ok / stale / unavailable
  ical.ts               převod iCal na obsazené intervaly a události (UID, kódy rezervací)
  http.ts               JSON odpovědi s bezpečnostními hlavičkami
  booking/
    handler.ts          POST /api/reservations
    validation.ts       serverová validace termínu, kapacity a kontaktů
    pricing.ts          jediný výpočet ceny (ceník z D1, slevy, zaokrouhlení)
    quote.ts            POST /api/quote (cenová nabídka, jen čtení)
    external.ts         čerstvá kontrola proti exportu e-chalup, rozpoznání vlastní rezervace
    db.ts               D1: atomické založení rezervace, obsazené noci, data pro export
    conflicts.ts        detekce kolizí vlastních rezervací s cizími událostmi exportu
    cron.ts             Cron Trigger: čerstvý export → detekce kolizí → upozornění
    alerts.ts           e-mailové upozornění správci (Resend), outbox notified_at
    export.ts           GET /api/reservations.ics (soukromý iCal feed)
    ics.ts              serializace iCalendar (escaping, zalamování, CRLF)
  secrets.ts            porovnání tokenů v konstantním čase
migrations/             SQL migrace D1
tests/                  unit testy + syntetické fixtures (smyšlené rezervace), lokální D1 (Miniflare)
public/                 fotografie, favicon
scripts/finalize-static.mjs   úklid po buildu, ponechá statický výstup
vendor/                 základní styly shadcn/Tailwind importované z app/globals.css
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
  - volitelný secret `BOOKING_API_TOKEN` (jen neveřejné prostředí),
  - secret `TURNSTILE_SECRET_KEY` (Preview testovací, produkce skutečný) a binding
    `BOOKING_RATE_LIMITER` (`ratelimits`, produkce namespace 1001, Preview 1002),
  - secrets `RESEND_API_KEY`, `CONFLICT_ALERT_EMAIL` a volitelně `CONFLICT_ALERT_FROM` pro e-mailové
    upozornění na kolize (Cron každých 5 minut),
  - `BOOKING_ICAL_EXPORT_ENABLED` (produkce i `previews`) a secret `BOOKING_ICAL_EXPORT_TOKEN`
    (min. 32 znaků) pro výstupní iCal.
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
  databázi. `wrangler d1` čte jen top-level `d1_databases` (ne blok `previews`), proto má
  testovací databáze vlastní konfiguraci `wrangler.preview-migrations.jsonc` (stejné ID
  jako `previews.d1_databases`, slouží jen pro `wrangler d1`, ne pro deploy):

  ```bash
  # Preview / test
  npx wrangler d1 migrations apply chalupa-vsetice-rezervace-test --remote --config wrangler.preview-migrations.jsonc
  npx wrangler d1 execute chalupa-vsetice-rezervace-test --remote --config wrangler.preview-migrations.jsonc \
    --command "INSERT INTO meta (key, value) VALUES ('environment', 'preview')"
  # Produkce (až po ověření Preview, před merge)
  npx wrangler d1 migrations apply chalupa-vsetice-rezervace --remote
  npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
    --command "INSERT INTO meta (key, value) VALUES ('environment', 'production')"
  ```
