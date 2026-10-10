# Chalupa Všetice – web

Prezentační web rekreační chalupy ve Všeticích (Středočeský kraj). Stránka je
jednostránková aplikace v Reactu a TypeScriptu předgenerovaná do statického HTML.
Obsazenost poskytuje malé API v Cloudflare Workeru. Web i API běží na
Cloudflare Workers.

- Produkce: https://chalupavsetice.cz/
- Testovací prostředí: https://chalupa-vsetice-web.gamemanlpvlogs.workers.dev/

## Funkce

- **Jazyky:** čeština, angličtina, němčina a ukrajinština – celý web včetně kalendáře,
  rezervačního panelu, hlášek a popisků pro čtečky. Přepínač CS / EN / DE / UA v hlavičce,
  viz [Jazykové verze](#jazykové-verze-i18n).
- **Úvodní sekce, informace o chalupě, vybavení a ceník** jsou responzivní a na
  mobilu (≤ 640 px) se přeskládají do jednoho sloupce.
- **Rezervační kalendář** je vlastní React komponenta:
  - zobrazuje 1–3 měsíce podle skutečné šířky panelu a šipkami lze procházet
    12 měsíců dopředu,
  - názvy měsíců a dnů má v jazyce webu (Intl), začíná pondělím a zvýrazňuje dnešek,
  - rozlišuje volné a obsazené dny i dny příjezdu a odjezdu jiných hostů,
  - první klik vybere příjezd a druhý odjezd; opakovaný klik na zvolený příjezd
    výběr zruší; pobyt přes obsazené období ani v minulosti vybrat nejde,
  - pokus o pobyt kratší než `MIN_NIGHTS` krátce terakotově probliká ring kolem
    kliknutého dne (~650 ms, pozadí a číslo dne beze změny, bez trvalého stavu)
    a hláška se zobrazí v tlumené terakotové barvě s krátkým pulsem
    (`transform: scale`); každý další neplatný pokus odezvu spustí znovu, s
    `prefers-reduced-motion` zůstane jen změna barvy,
  - ovládá se myší, dotykem i klávesnicí (šipky, Enter, mezerník) a každý den má
    přístupný popisek.
- **Rezervační panel** sdílí s kalendářem jeden stav pobytu. Datumová pole
  procházejí stejnou validací a panel zobrazuje příjezd, odjezd, počet hostů (max. 7),
  počet nocí a cenu ze serveru (`POST /api/quote`, při každé změně termínu nebo hostů).
  Web cenu nepočítá: pevnou cenu termínu (exact-stay) označí „Pevná cena pro tento termín“,
  u slevy ukáže rozpis ze serveru. Během načítání se žádná částka nezobrazuje, chyby jsou
  srozumitelné hlášky v jazyce webu (u chyby serveru s „Zkusit znovu“). Před výběrem termínu
  panel ukáže jen orientační „Běžně 2 990 Kč / noc“ (`PRICE_PER_NIGHT` přes `formatPrice`)
  s poznámkou (cena se může lišit podle termínu, minimální délka pobytu 2 noci, delší pobyty
  mohou být zvýhodněné); nic nepočítá. Počet nocí v poznámce je `MIN_NIGHTS`
  (`lib/booking/rules.ts`) – stejné pravidlo vynucuje výběr termínu, `/api/quote` i rezervace.
  Ceník na stránce neuvádí univerzální cenu za noc – cena pobytu závisí na termínu.
- **Data v panelu** se zadávají a zobrazují vždy v pořadí den → měsíc → rok: vlastní pole
  `DD.MM.RRRR` (nezávislé na formátu nativního `<input type="date">`, který může být americký)
  s volitelným nativním výběrem data; interně a v API jen ISO `YYYY-MM-DD`.
- **Rezervační formulář** (jen kde ho povolí `GET /api/booking-config`, zatím jen Worker
  Previews): „Pokračovat k rezervaci“ otevře pod kalendářem a panelem kontaktní údaje
  a „Odeslat rezervaci“ (`POST /api/reservations`, ochrana Invisible Turnstile), viz
  [Rezervační formulář](#rezervační-formulář-frontend).
- **Poptávka** (produkce, dokud je rezervace vypnutá) vede na oficiální profil chalupy na
  e-chalupy.cz. Výběr termínu na webu není rezervací. Termín a počet hostů host uvede
  v poptávce na e-chalupách.
- **WebMCP:** pokud prohlížeč podporuje experimentální API `document.modelContext`,
  stránka zaregistruje nástroj `estimate_stay`. Ten vybere termín stejnou validací
  a vrátí cenu z `/api/quote` (`priceCzk`, `pricingMode`); nevytváří rezervaci ani poptávku.

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

## Jazykové verze (i18n)

Web je v češtině (výchozí), angličtině, němčině a ukrajinštině. Všechny uživatelské texty
komponent – navigace, obsah, kalendář, rezervační panel, hlášky, `aria-label` a `alt` – jdou přes
překladové klíče; v komponentách nejsou pevné texty (hlídá test).

- **Katalogy:** `lib/i18n/messages/cs.ts` (vzor), `en.ts`, `de.ts`, `ua.ts`. Klíče jsou
  významové podle oblasti (`nav.about`, `calendar.legend.free`, `booking.quote.loading`,
  `pricing.rent.value`), ne české věty. Hodnoty jsou prostý text bez HTML; odkazy a zvýraznění
  skládá komponenta (např. odkaz na e-chalupy.cz za textem `availability.verifyOn`).
- **Typová kontrola:** `MessageKey` a `Messages` se odvozují z českého katalogu. Ostatní
  katalogy jsou `satisfies Messages`, takže chybějící i přebytečný klíč je chyba `tsc`.
  Test navíc ověří stejné parametry `{…}`, všechny tvary množného čísla a že překlad není
  česky.
- **Množná čísla:** `plural(key, count)` vybírá tvar podle `Intl.PluralRules` jazyka
  (`one` / `few` / `many` / `other`; čeština a ukrajinština mají `few` i `many`, angličtina
  a němčina jen `one` / `other`).
- **Formátování:** data, názvy měsíců, dny v týdnu a rozsahy měsíců přes `Intl.DateTimeFormat`
  (interně zůstávají ISO data `YYYY-MM-DD`), ceny přes `Intl.NumberFormat`.
- **Jazyk a měna jsou oddělené.** Měna je vždy CZK (`28 500 Kč`, `CZK 28,500`, `28.500 CZK`);
  angličtina ani němčina neznamenají EUR. Částky přicházejí ze serveru – cena termínu je vždy
  `totalCzk` z `POST /api/quote`, web ji nepočítá.
- **Fallback:** chybějící překlad se zobrazí česky. Je to jen pojistka – produkční katalogy
  jsou úplné (test).

### Volba jazyka a persistence

1. `?lang=en|de|ua|cs` v adrese (sdílitelný odkaz),
2. jinak uložená preference v `localStorage` (`chalupa-vsetice.locale`),
3. jinak čeština.

Přepnutím v hlavičce se jazyk uloží do `localStorage` a adresa se upraví na `?lang=…`
(čeština bez parametru) přes `history.replaceState` – bez reloadu. Změna jazyka jen
přerenderuje texty; termín, hosté i načtená cena zůstanou (nový požadavek na `/api/quote` se
nevolá). Nedostupné `localStorage` (soukromý režim) nevadí, jazyk se jen nezapamatuje.

Web je jedna staticky předrenderovaná stránka, proto je jazyk v query parametru, ne v cestě
(`/en/`) – bez změny routingu a buildu. Statický HTML je česky (`<html lang="cs">`, titulek
a popis z českého katalogu); jiný jazyk se nastaví hned po načtení v prohlížeči včetně
`lang`, `<title>` a `meta description`. Vyhledávače tak indexují jen češtinu – samostatné
předrenderované jazykové stránky (`/en/` …) s `hreflang` jsou případný navazující krok.

### Přidání textu nebo jazyka

- **Nový text:** klíč do `cs.ts` a stejný klíč do `en.ts`, `de.ts`, `ua.ts` (jinak `tsc`
  selže), v komponentě `const { t } = useI18n(); t('oblast.klic')`.
- **Nový jazyk:** `messages/<kód>.ts` (`satisfies Messages`), kód do `LOCALES`, název do
  `LOCALE_NAMES`, locale pro Intl do `INTL_LOCALE`, krátký formát data do `SHORT_DATE`
  a katalog do `CATALOGS` v `lib/i18n/index.ts`. Test ověří úplnost a tvary množného čísla.

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

- Databázové tabulky pro rezervace, obsazené noci, denní čítač veřejného kódu rezervace (= variabilní symbol) a konfiguraci prostředí.
- Platební údaje rezervace: stav `pending_payment`, splatnost 24 h, QR Platba (SPAYD) a ruční údaje v potvrzení.
- Atomické vytvoření rezervace prostřednictvím D1 batch transakce.
- Databázová ochrana proti dvojité rezervaci pomocí unikátního záznamu každé obsazené noci.
- Serverová validace termínů, kapacity a kontaktních údajů.
- Serverový ceník v D1: výchozí cena za noc, vlastní ceny konkrétních nocí, množstevní slevy podle délky pobytu a pevná cena přesně daného pobytu (exact-stay); cenová nabídka `POST /api/quote`.
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

**Výsledek posledního vývojového běhu: 300/300 úspěšných testů.**

| Testovací soubor | Počet | Zaměření |
|---|---:|---|
| ical.test.ts | 20 | Parsování iCalendar, časová pásma, opakované a zrušené události, chybné exporty. |
| availability.test.ts | 21 | Načítání obsazenosti, cache, výpadky externí služby a neúplná data. |
| occupancy.test.ts | 18 | Slučování obsazených intervalů, kontrola termínů a chování kalendáře (včetně zrušení výběru opakovaným klikem na příjezd), minimální délka pobytu (kalendář i datumová pole). |
| booking.test.ts | 9 | Validace rezervací, ceny, kontakty, vlastní iCal UID a propojení D1 s kalendářem. |
| reservations-api.test.ts | 20 | Rezervační API, autorizace, idempotence, souběh požadavků a chybové stavy, minimální délka pobytu; kontrakt odpovědi s kódem `DDMMYYNN`, splatností a platebními údaji, fail closed bez platné platební konfigurace, vyčerpání kódů dne. |
| reservations-db.test.ts | 21 | Databázová omezení, atomické transakce, rollback a ochrana proti kolizím; denní čítač kódu `DDMMYYNN` (souběh, pražská půlnoc, nový den, limit 99), splatnost +24 h. |
| ical-export.test.ts | 19 | Výstupní iCal: formát RFC 5545, escaping, stabilita UID, zrušení (STATUS:CANCELLED), autorizace, chyby D1 a prostředí, únik osobních údajů. |
| conflicts.test.ts | 18 | Detekce kolizí během zpoždění synchronizace: překryvy a hranice, ozvěny, idempotence, souběh, úplný/neúplný snapshot, výpadek e-chalup, upozornění. |
| conflict-cron.test.ts | 12 | Cron detekce a e-mailové upozornění: odeslání a notified_at, žádný druhý e-mail, retry po chybě providera, nesoulad prostředí, výpadek a neúplný export, souběh s /api/availability, bez osobních údajů. |
| booking-public.test.ts | 16 | Veřejný POST: Turnstile (platný, neplatný, chybějící, nedostupný), rate limit, idempotentní retry a dvojklik, chybové kódy, bez úniku osobních údajů a secrets. |
| pricing.test.ts | 33 | Ceník: výchozí a vlastní ceny nocí, prahy slev, zaokrouhlení, přelom měsíce a roku, pevná cena pobytu (přesná shoda, priorita, neplatná data, beze vlivu na dostupnost), `/api/quote` (kontrakt, validace, neplatný ceník, výpadek D1, žádné zápisy), shoda ceny nabídky a rezervace, `price-mismatch`. |
| reservation-note.test.ts | 17 | Poznámka hosta: NULL pro prázdné hodnoty, víceřádkový text, Unicode a NFC, limit 2000 znaků, zakázané řídicí a bidi znaky, SQL/HTML text jen jako text, není ve veřejné odpovědi ani v logách, idempotence, escapování v iCal exportu, CHECK v D1. |
| d1-migrations.test.ts | 21 | Kontrola D1 migrací před deployem: číslování, konzistence konfigurací (oddělené D1, produkční POST vypnutý), čekající a neznámé migrace, fail-closed při chybě, detekce destruktivních migrací, ruční aplikace jen v terminálu s potvrzením, záloha před destruktivní migrací produkce. |
| smoke.test.ts | 8 | Smoke test veřejných endpointů proti skutečnému Workeru: produkce (POST 404, `booking-config` vypnutý) a Preview, bez tokenů a zápisů, odhalení zapnutého POST, výpadku D1, úniku osobních údajů a veřejného exportu. |
| frontend-quote.test.ts | 14 | Frontend rezervační sekce: cena jen z `/api/quote` (kontrakt proti skutečnému handleru), nightly se slevou, exact-stay, 422 a chyby serveru/sítě jako české hlášky, načítání bez staré ceny, souběh (starší odpověď nepřepíše novější), nový požadavek při změně termínu a hostů, žádný klientský výpočet ceny. |
| i18n.test.ts | 17 | Jazykové verze: úplnost katalogů cs/en/de/ua (klíče, parametry, plurály, žádný český text ani HTML), fallback, volba jazyka (?lang, localStorage, čeština) a persistence, množná čísla, data a CZK v každém jazyce, kalendář, rezervační panel po přepnutí, přepínač, žádné pevné texty v komponentách ani pevná cena noci (3 000 / 2 990 Kč); orientační cena jen z `PRICE_PER_NIGHT`. |
| date-input.test.ts | 8 | Vstup data DD.MM.RRRR ↔ ISO: přestupný rok, neexistující den a měsíc, rozepsané datum bez chyby, odmítnutí amerického a ISO tvaru, všechna zobrazená data den → měsíc → rok (angličtina bez měsíc/den). |
| reservation-form.test.ts | 20 | Rezervační formulář: request podle kontraktu, blokace odeslání (termín, cena, kontakty; Turnstile tlačítko neblokuje), kliknutí → Invisible Turnstile → POST, selhání Turnstile bez POST, Idempotency-Key a token svázané s operací (retry = stejný klíč i token bez nové challenge, nová operace = nový token i klíč, i po price-mismatch), chybové kódy → hlášky ve všech jazycích, POST proti skutečnému handleru, `GET /api/booking-config`, Preview Invisible site key jen ve `previews`; potvrzení jen z dat serverové odpovědi (neúplná nebo nekonzistentní odpověď se nepřijme). |
| invisible-turnstile.test.ts | 8 | Invisible Turnstile na klientu: widget připravený předem bez spuštění challenge, po kliknutí jen `execute`, nejvýš jeden token na widget a čerstvý widget na pozadí, bez automatického obnovování, ignorování pozdních callbacků, chyba / timeout / prázdný token → `turnstile-failed`, nenačtený skript → `turnstile-unavailable` s opakováním přípravy, odpojení formuláře. |
| stay-feedback.test.ts | 5 | Vizuální odezva na pobyt kratší než `MIN_NIGHTS`: validace a stav pobytu beze změny, nový trigger s kliknutým dnem při každém pokusu, validní klik ani jiné chyby flash nespustí, flash dne bez trvalého stavu a bez pohybu, pulse hlášky jen přes `transform`, `prefers-reduced-motion` bez animace. |
| payment.test.ts | 8 | Platby: pražské datum → `DDMMYY`, `NN` 01–99, splatnost +24 h v UTC, IBAN (kontrolní součet, odvození čísla účtu), SPAYD (serverová cena, VS = kód, zpráva `Rezervace {kód}`), lokální QR, kontrola, že repozitář neobsahuje skutečný IBAN. |
| **Celkem** | **333** | |

### Testované scénáře

- Úspěšné vytvoření rezervace a přidělení kódu `DDMMYYNN` (= variabilní symbol) z denního čítače.
- Pražský den kolem půlnoci (UTC vs. `Europe/Prague`, zimní i letní čas), nový den od `01`.
- Limit 99 rezervací za den: 100. se nezaloží (fail closed), čítač nepřeteče.
- Splatnost `created_at + 24 h`, SPAYD se serverovou cenou, VS = kód, zpráva `Rezervace {kód}`.
- Chybějící nebo neplatný `PAYMENT_IBAN` → 503, nic se nezapíše ani nezaloguje.
- Souběžné vytváření 20 rezervací stejného termínu – uspěje pouze jedna.
- Odmítnutí úplných i částečných překryvů rezervací.
- Povolení navazujících pobytů se společným dnem příjezdu a odjezdu.
- Atomické vrácení neúspěšné transakce včetně denního čítače kódu rezervace.
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
- Rezervace dostala veřejný kód `DDMMYYNN` (= variabilní symbol), správnou cenu, splatnost
  +24 h a stav pending_payment; success panel ukazuje QR Platbu a ruční platební údaje.

### 3. Okamžitá synchronizace kalendáře

- Nově vytvořená rezervace se okamžitě objevila v GET /api/availability.
- Existující rezervace z e-chalup zůstaly zachované.
- Obsazenost byla vizuálně ověřena také na testovací verzi webu.
- Změna nevyžadovala čekání na synchronizaci e-chalup.

### 4. Ochrana proti dvojité rezervaci

- Druhý požadavek na již rezervovaný termín byl odmítnut (HTTP 409).
- Následná kontrola D1 potvrdila jedinou vytvořenou rezervaci.
- Počet obsazených nocí odpovídal původní rezervaci.
- Neúspěšný požadavek nespotřeboval další pořadí kódu rezervace.

### 5. Idempotence

- Opakované odeslání původního požadavku se stejným Idempotency-Key vrátilo původní rezervaci.
- API správně nastavilo replayed: true.
- Veřejný kód (= variabilní symbol) zůstal nezměněný.
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
- Workers Builds: deploy i Worker Previews běží přes kontrolu D1 migrací (`pnpm run deploy`,
  `pnpm run deploy:preview`) s build tokenem, který má k D1 jen Read. Ověřeno na Preview
  i produkci (kontrola migrací a smoke test 8/8).
- Výstupní iCal `/api/reservations.ics`: zapnutý v produkci i ve Worker Previews a připojený k importu v e-chalupách. Celý tok (import, zrušení přes `STATUS:CANCELLED`) je ověřený na produkci syntetickou rezervací, která byla následně odstraněna.
- Stávající způsob poptávky prostřednictvím e-chalup: zachován.

## Navazující vývoj

Dosud nejsou implementovány:

- Zapnutí rezervačního formuláře v produkci (produkční Turnstile widget a secret, `BOOKING_API_ENABLED`).
- Potvrzovací e-mail hostovi (ve 4 jazycích; v Preview jen na testovací schránku) – použije
  stejná platební data (`paymentInstructions`).
- Expirace nezaplacených rezervací po splatnosti a uvolnění termínu, párování plateb, označení `paid`.
- Administrace rezervací a branding e-mailu.

Před veřejným spuštěním rezervačního systému proběhne také závěrečná kontrola oprávnění, přístupových údajů, starých testovacích deploymentů a nastavení diagnostických záznamů.

## Rezervační backend – technický popis

Připravená databázová a serverová část budoucí rezervace z webu. Formulář na webu,
platby a e-maily zatím neexistují. Výstupní iCal pro e-chalupy je implementovaný
a aktivní v produkci. D1 je jen
technické úložiště, provozní administrací zůstávají e-chalupy.

```
POST /api/reservations → validace → čerstvý export e-chalup → D1 batch (kód/VS + rezervace + noci)
```

### Datový model (`migrations/0001_rezervace.sql`)

- **`reservations`:**
  - interní UUID (host ho nikdy nevidí), veřejný kód `DDMMYYNN` (UNIQUE; starší rezervace `CV-7K3M9Q`),
  - příjezd, odjezd, počet hostů (CHECK 1–7),
  - jméno, příjmení, telefon, e-mail,
  - cena v Kč, variabilní symbol (UNIQUE; u nových rezervací shodný s veřejným kódem),
  - splatnost platby `payment_due_at` (`migrations/0008_kod_rezervace_platba.sql`, UTC, NULL u starších),
  - stav a stabilní iCal UID (`rezervace-<uuid>@chalupavsetice.cz`, UNIQUE, spolu s `ical_sequence`),
  - volitelný `idempotency_key` pro opakované odeslání,
  - volitelná poznámka hosta `note` (`migrations/0007_poznamka_hosta.sql`, NULL nebo 1–2000 znaků).
- **Stavy:** `pending_payment` (čeká na ruční ověření platby), `paid`, `cancelled`.
  Nezaplacené rezervace se automaticky neruší.
- **`reserved_nights`:** jedna řádka na noc, `night` je PRIMARY KEY. Databáze tak sama
  zabrání tomu, aby dvě rezervace obsadily stejnou noc, i při souběžných požadavcích.
- **`reservation_code_counters`:** denní čítač pořadí `NN` veřejného kódu (klíč = pražský den,
  CHECK 1–99), viz Kód rezervace a platba.
- **`sequences`:** čítač variabilního symbolu starších rezervací (dvojčíslí roku + 6 číslic,
  např. `26000001`). Nový kód ho nepoužívá; zůstává kvůli zpětné kompatibilitě.
- **`meta`:** označení databáze (`environment` = `production` / `preview`), viz Bezpečnost.

### Kód rezervace a platba (`lib/booking/payment.ts`)

- **Veřejný kód `DDMMYYNN`** (např. `10102602`) je jediný veřejný identifikátor rezervace
  a zároveň variabilní symbol. `DDMMYY` = den vytvoření v `Europe/Prague` (z `created_at`
  v UTC; `2026-10-09T22:30:00Z` → `101026…`), `NN` = pořadí rezervace v tomto pražském dni
  `01–99`. Kód se nikdy nemění. Uložený je v `public_code` a stejná hodnota v `variable_symbol`
  (sloupec zůstává NOT NULL kvůli zpětné kompatibilitě, druhý identifikátor nevzniká).
- **Atomické přidělení:** jeden D1 batch – UPSERT `reservation_code_counters`
  (`ON CONFLICT (day) DO UPDATE SET last = last + 1`), INSERT rezervace s kódem z čítače
  a obsazení nocí. Nikdy `COUNT(*) + 1`. D1 provádí batche postupně, takže souběžné rezervace
  nedostanou stejné `NN`; pojistkou je UNIQUE na `public_code` i `variable_symbol`. Neúspěšný
  batch se vrátí celý včetně čítače (mezery v řadě by ale nevadily).
- **Limit 99 za den – fail closed:** 100. rezervace pražského dne poruší CHECK
  `reservation_code_limit`, batch se vrátí a API odpoví 503 `reservation-codes-exhausted`.
  Žádné přetečení na `00`, žádná duplicita. Další pražský den začíná od `01`.
- **Stav a splatnost:** nová rezervace má `status = 'pending_payment'` a
  `payment_due_at = created_at + 24 h` (UTC). Podle splatnosti se zatím nic neruší ani neuvolňuje.
- **Částka:** 100 % serverem spočítané ceny rezervace (`price_czk` = `totalCzk` z `quoteStay`).
- **Bankovní účet:** jen ze secretu `PAYMENT_IBAN` (český IBAN, ověřený kontrolní součet).
  Tuzemské číslo účtu pro ruční platbu (`[předčíslí-]číslo/kód banky`) se z IBAN odvozuje, takže
  QR a ruční údaje se nemohou rozejít. Žádné bankovní údaje v repozitáři, testech (jen fiktivní
  účet banky `9999`) ani v logách. Chybí-li secret nebo je neplatný, `POST /api/reservations`
  odpoví 503 `not-configured` ještě před ověřením Turnstile a nic nezapíše.
- **SPAYD (QR Platba):** `buildSpayd` – deterministický řetězec
  `SPD*1.0*ACC:<IBAN>*AM:<částka>.00*CC:CZK*MSG:Rezervace <kód>*X-VS:<kód>`. QR se vykresluje
  lokálně v prohlížeči (knihovna `uqr`, bez externí služby; bankovní údaje stránku neopouštějí).
- **Sdílená data:** `paymentInstructions()` je jediný zdroj platebních údajů (částka, účet, IBAN,
  VS, zpráva, splatnost, SPAYD) – používá ho odpověď API a má ho použít i budoucí potvrzovací e-mail.

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
   - 2–30 nocí (`MIN_NIGHTS` / `MAX_NIGHTS` v `lib/booking/rules.ts`),
   - 1–7 hostů,
   - jméno, telefon a e-mail bez řídicích znaků,
   - volitelná poznámka `note` (viz [Poznámka hosta](#poznámka-hosta-note)).
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
7. Odpověď 201 obsahuje veřejný souhrn rezervace a platební údaje, ale žádné interní ID,
   kontaktní údaje, poznámku ani secrets:

   ```json
   {
     "reservation": { "reservationCode": "10013001", "arrival": "2030-02-01", "departure": "2030-02-04",
       "nights": 3, "guests": 2, "totalCzk": 8970, "status": "pending_payment",
       "paymentDueAt": "2030-01-11T10:00:00.000Z" },
     "payment": { "amountCzk": 8970, "currency": "CZK", "accountNumber": "1234567890/9999",
       "iban": "CZ1999990000001234567890", "variableSymbol": "10013001", "message": "Rezervace 10013001",
       "dueAt": "2030-01-11T10:00:00.000Z", "spayd": "SPD*1.0*ACC:CZ1999990000001234567890*AM:8970.00*CC:CZK*MSG:Rezervace 10013001*X-VS:10013001" }
   }
   ```

   (Účet v příkladu je fiktivní.) Stejný `Idempotency-Key` se stejným obsahem vrátí původní rezervaci (200,
   `replayed: true`) – ještě před ověřením Turnstile, protože token je jednorázový. Siteverify
   dostává `idempotency_key` odvozený z `Idempotency-Key`, takže souběžný dvojklik se stejným
   klíčem a tokenem skončí jednou rezervací. Bez klíče druhý požadavek odmítne Turnstile
   (použitý token) nebo D1 (obsazené noci). Frontend má posílat náhodný `Idempotency-Key`
   (16–100 znaků `A–Z a–z 0–9 _ -`) jednou na odeslání formuláře; klíč nesmí obsahovat osobní údaje.

#### Poznámka hosta (`note`)

Volitelné pole `note?: string | null` v těle `POST /api/reservations`. Prostý text, žádné HTML.

- Chybějící, `null`, prázdná nebo jen bílé znaky → v D1 `NULL`. Jiný typ než řetězec → 422.
- Normalizace: konce řádků `\r\n` a `\r` → `\n`, Unicode NFC, ořez bílých znaků na začátku
  a konci. Uvnitř se text nemění (nové řádky, odsazení, emoji zůstávají).
- Maximálně **2000 znaků** po normalizaci (Unicode code pointy; stejně počítá `length()`
  v SQLite). Limit těla požadavku je proto 16 KB.
- Povolený je běžný Unicode text včetně diakritiky, emoji (i ZWJ sekvencí), nových řádků
  a tabulátoru. Odmítne se (422 `invalid-request`, `fields: ["note"]`): NUL a ostatní řídicí
  znaky C0/C1, DEL, U+2028/U+2029, bidi přepisy U+202A–202E a U+2066–2069 a neplatné UTF-16
  (osamocené surrogaty) – kdekoli v textu, i na okrajích.
- Ukládá se normalizovaný prostý text; nic se destruktivně nesanitizuje. Escapuje se až při
  výstupu podle cílového formátu: iCal TEXT (`escapeText`), budoucí HTML výstup musí text
  escapovat pro HTML. Zápis do D1 jen parametrizovaně (`.bind`), D1 má navíc CHECK na typ a délku.
- Poznámka **není** ve veřejné odpovědi rezervace (201 ani replay), v `/api/availability`
  ani v chybových odpovědích a její obsah se **neloguje**. Je jen v autorizovaném iCal exportu
  (`DESCRIPTION` aktivní události; zrušená událost ji nenese).
- Idempotence: do otisku požadavku vstupuje normalizovaná poznámka (jen když je vyplněná –
  otisk požadavku bez poznámky je stejný jako dřív). Stejný `Idempotency-Key` + stejná
  poznámka (i v jiném zápisu, např. CRLF nebo NFD) = replay; jiná poznámka =
  422 `idempotency-key-reused`.

#### Chybové kódy (`{ "error": "<kód>" }`)

| HTTP | `error` | Význam pro frontend |
|---|---|---|
| 400 | `invalid-json`, `invalid-idempotency-key` | chybný požadavek (chyba klienta) |
| 413 / 415 | `payload-too-large` / `unsupported-media-type` | chybný požadavek |
| 422 | `invalid-request` (+ `fields`: názvy chybných polí, bez hodnot) | neplatné údaje ve formuláři |
| 422 | `idempotency-key-reused` | stejný klíč s jiným obsahem – vygenerovat nový klíč |
| 400 | `turnstile-required` | chybí ověření Turnstile |
| 403 | `turnstile-failed` | ověření Turnstile neprošlo – nový token (nová challenge) a odeslat znovu |
| 429 | `rate-limited` | příliš mnoho pokusů, `Retry-After` v sekundách |
| 409 | `dates-unavailable` | termín je obsazený |
| 409 | `price-mismatch` (+ `priceCzk`) | cena se změnila – zobrazit novou cenu |
| 503 | `availability-check-failed`, `availability-incomplete` | dostupnost teď nejde bezpečně ověřit – zkusit později |
| 503 | `pricing-unavailable` | ceník v D1 je neplatný – cenu teď nejde spočítat |
| 503 | `turnstile-unavailable` | ověření Turnstile je dočasně nedostupné – zkusit později |
| 503 | `not-configured`, `service-unavailable`, `database-environment-mismatch`, `database-error` | interní chyba / výpadek (`not-configured` i při chybějícím/neplatném `PAYMENT_IBAN`) |
| 503 | `reservation-codes-exhausted` | vyčerpáno 99 kódů rezervace pro dnešní pražský den – nic se nezapsalo |
| 500 | `internal-error` | neočekávaná interní chyba |
| 404 / 405 | `not-found` / `method-not-allowed` | endpoint vypnutý / jiná metoda |

Odpovědi nikdy neobsahují stack trace, secrets, adresu exportu ani detaily databáze.

Logy obsahují jen druh události (`reservations: created`, `rejected (…)`), nikdy osobní
údaje ani adresu exportu.

### Rezervační formulář (frontend)

Formulář je pokračováním zeleného panelu (`BookingPanel` → `BookingForm`), ne nový krok,
modal ani stránka. Nabízí se jen tam, kde `GET /api/booking-config` vrátí
`{ "bookingEnabled": true, "turnstileSiteKey": "…" }`; jinak (produkce, chyba, chybějící site key)
web dál nabízí poptávku přes e-chalupy.

- **`GET /api/booking-config`** (`worker/booking/config.ts`) vrací jen `bookingEnabled`
  (`BOOKING_API_ENABLED === "true"`) a veřejný `turnstileSiteKey` (jen při zapnuté rezervaci).
  Žádné jiné nastavení. Smoke test v produkci ověřuje `bookingEnabled: false`.
- **Stav:** termín, hosté a nabídka zůstávají v `BookingSection` (jediný zdroj); kontakty
  (`firstName`, `lastName`, `email`, `phone`, volitelná `note`) jsou zvlášť, takže je změna
  termínu, hostů ani jazyka nesmaže. Otevřený formulář zůstává otevřený. Kontaktní část se
  vykresluje pod celým blokem kalendáře a panelu (panel si zachová výšku).
- **Data:** `DateField` drží jen rozepsaný text (`DD.MM.RRRR`); autoritativní je ISO hodnota
  v centrálním stavu. Rozepsané datum není chyba, neexistující úplné datum (32.12.2026) je inline
  chyba bez tiché opravy, chybný tvar se ohlásí při opuštění pole. Platné datum jde přes stejnou
  validaci jako kalendář (`lib/availability/stay.ts`) a spustí `/api/quote`.
- **Odeslání** je povolené jen s úplným termínem, aktuální nabídkou (`ready` pro stejný termín)
  a vyplněnými kontakty; Turnstile tlačítko neblokuje. Po kliknutí se nejdřív získá token
  z Invisible Turnstile, teprve potom proběhne POST (obojí jeden loading stav tlačítka).
  Request: `arrival`, `departure`, `guests`, kontakty,
  `note` (prázdná = `null`), `turnstileToken`, `expectedPriceCzk` (= `totalCzk` nabídky)
  a hlavička `Idempotency-Key` (`crypto.randomUUID()`). Formát kontaktů ověřuje server; chyby
  z 422 se zobrazí u polí (`aria-invalid`, `aria-describedby`).
- **Logická operace = Idempotency-Key + jeden Turnstile token** (stejný obsah requestu včetně
  `expectedPriceCzk`). Opakování po síťové chybě, timeoutu nebo dočasné chybě serveru („Zkusit
  znovu“) použije stejný klíč i stejný token bez nové challenge (server díky deterministickému
  `idempotency_key` pro Siteverify a idempotentnímu replay neztratí ani nezdvojí rezervaci).
  Nová operace = nový token i klíč: změna termínu, hostů nebo kontaktů, nové potvrzení po změně
  ceny, `turnstile-failed` / `turnstile-required`, `dates-unavailable`, 422. Spotřebovaný token se
  pro jinou operaci nikdy nepoužije. Nic se neodesílá automaticky.
- **Invisible Turnstile** (`invisibleTurnstile.ts`, `Turnstile.tsx`): skript i widget se připraví
  s otevřením formuláře (`render` s `execution: 'execute'`, `action: 'reservation'`,
  `refresh-expired: 'never'`, `retry: 'never'` – načte iframe, challenge nespustí), po kliknutí
  zbývá jen `execute`. Widget nic nezobrazuje ani nezabírá místo a vydá nejvýš jeden token; pak
  se odstraní a na pozadí se připraví čerstvý. Fáze odeslání jsou označené `performance.mark`
  (`booking:submit`, `booking:token`, `booking:post-start`, `booking:post-end`,
  `booking:success-render`). Chyba, timeout nebo nedokončená challenge = `turnstile-failed` bez POST;
  nenačtený skript = `turnstile-unavailable`. Režim Invisible určuje site key (v dashboardu);
  `appearance: 'interaction-only'` je jen pojistka pro chybně nastavený viditelný klíč.
- **Změna ceny (`409 price-mismatch`):** nic se znovu neodešle, kontakty zůstanou, nabídka se
  znovu načte z `/api/quote` (summary ukáže novou cenu i rozpis) a panel zobrazí „Cena se mezitím
  změnila z X na Y. Zkontrolujte ji a rezervaci znovu potvrďte.“ Další odeslání = vědomé
  potvrzení s novým klíčem.
- **Úspěch:** potvrzení v panelu (bez eyebrow) – titulek „Rezervace přijata“, informace, že
  rezervace čeká na platbu a do kdy ji uhradit, termín, délka pobytu, hosté, celková cena a
  „Kód rezervace (= VS)“. Pod tím blok Platba: QR Platba, číslo účtu a splatnost; IBAN je ve
  sbaleném nativním `<details>` „Další platební údaje“. Částka a variabilní symbol se pod QR
  neopakují (jsou v souhrnu jako celková cena a kód rezervace). Vše je ze serverové odpovědi
  (`parseConfirmation` odmítne neúplnou nebo nekonzistentní odpověď); nic se nedopočítává.
  Splatnost: den → měsíc → rok a čas v `Europe/Prague` (`formatDeadline`). Nepodaří-li se QR
  vykreslit, zobrazí se jen hláška a ruční údaje – rezervace platí dál. O e-mailu se zatím nic
  netvrdí (odesílání potvrzení není implementované).
  Kontaktní část pod blokem zmizí a stránka se po vykreslení posune zpět k bloku (celý grid,
  pokud se vejde do okna, jinak potvrzení); reveal animace respektuje `prefers-reduced-motion`.

### Ceník a cenová nabídka

Ceník žije v D1 (`migrations/0005_ceny.sql`, `migrations/0006_ceny_pobytu.sql`) a spravuje se zatím jen přes Wrangler CLI –
bez administrace a bez API pro zápis. Jediný výpočet ceny je `worker/booking/pricing.ts`;
používá ho `POST /api/quote` i `POST /api/reservations`.

```sql
daily_prices     (date TEXT PRIMARY KEY 'YYYY-MM-DD', price_czk INTEGER 1–1 000 000)
length_discounts (id, min_nights INTEGER UNIQUE >= 1, discount_percent INTEGER 0–100)
stay_prices      (arrival_date, departure_date) PRIMARY KEY, total_czk INTEGER 1–30 000 000
                 – skutečná data YYYY-MM-DD, departure_date > arrival_date
```

**Priorita pravidel:**

1. **Pevná cena pobytu (`stay_prices`, `pricingMode: "exact-stay"`)** – existuje-li řádek
   přesně pro tento příjezd a odjezd, jeho `total_czk` je výsledná cena. `daily_prices`, výchozí
   cena ani `length_discounts` se nepoužijí: `subtotalCzk = totalCzk`, `discount: null`,
   `nightlyPrices: []` (rozpis po nocích u pevné ceny neexistuje).
2. **Jinak výpočet po nocích (`pricingMode: "nightly"`)** – algoritmus níže.

**Exact-stay je jen cenové pravidlo, ne omezení rezervací.** Jiný termín (i o jeden den
posunutý příjezd nebo odjezd) pravidlo ignoruje a dostane běžnou cenu po nocích. Pravidlo
neblokuje žádné noci ani jiné rezervace; když někdo mezitím rezervuje část jeho období, pravidlo
zůstane uložené, ale celý interval už přirozeně nebude dostupný. Povinné minimum nocí, povinný
příjezd/odjezd nebo balíčky zatím neexistují – případná budoucí vrstva omezení bude samostatná
(validace před výpočtem ceny) a na `stay_prices` může jen odkazovat; tabulka proto nenese názvy
ani metadata balíčků.

**Výpočet po nocích** (vše v celých Kč):

1. Pro každou noc pobytu (od příjezdu včetně do odjezdu bez noci odjezdu) se vezme
   `daily_prices.price_czk`, jinak výchozí cena `PRICE_PER_NIGHT` (2 990 Kč, `lib/booking/rules.ts`).
2. `subtotalCzk` = součet cen nocí.
3. Sleva: pravidlo s nejvyšším `min_nights`, které je ≤ počtu nocí. Žádné pravidlo = bez slevy.
   Slevy se nesčítají.
4. **Zaokrouhlení:** `amountCzk = floor(subtotalCzk × percent / 100)` – sleva se zaokrouhluje
   dolů na celé Kč (host nikdy nedostane víc slevy, než odpovídá procentu).
   `totalCzk = subtotalCzk − amountCzk`. Příklad: 23 331 Kč × 5 % = 1 166,55 → sleva 1 166 Kč,
   celkem 22 165 Kč.
5. Neplatná data v načteném ceníku (nečíselná nebo nekladná cena, procento mimo 0–100, duplicitní
   práh, neplatná pevná cena pobytu) = výpočet se odmítne (503 `pricing-unavailable`), nikdy tichý návrat k výchozí ceně.
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
  "pricingMode": "nightly",
  "subtotalCzk": 29900,
  "discount": { "type": "length", "minNights": 7, "percent": 5, "amountCzk": 1495 },
  "totalCzk": 28405,
  "nightlyPrices": [{ "date": "2030-12-07", "priceCzk": 2990 }, "…"]
}
```

Pevná cena pobytu (`stay_prices`):

```json
{
  "arrivalDate": "2026-12-29",
  "departureDate": "2027-01-02",
  "nights": 4,
  "pricingMode": "exact-stay",
  "subtotalCzk": 29900,
  "discount": null,
  "totalCzk": 29900,
  "nightlyPrices": []
}
```

`pricingMode` je `"nightly"` nebo `"exact-stay"`; frontend podle něj pozná pevnou cenu celého
pobytu a u ní nezobrazuje rozpis po nocích (nespoléhá na `nightlyPrices.length === nights`).
Závazná částka je vždy `totalCzk`. `discount` je `null`, když se žádná sleva neuplatní. Validace termínu a počtu hostů je stejná
jako u rezervace (minulost, horizont 365 dní, 2–30 nocí, 1–7 hostů); chyba = 422 `invalid-request`
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

Pevná cena přesně daného pobytu (exact-stay). Pro testovací D1 stejné příkazy s
`chalupa-vsetice-rezervace-test --remote --config wrangler.preview-migrations.jsonc`.

```bash
# Vytvoření nebo změna pevné ceny pobytu 29. 12. 2026 → 2. 1. 2027
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "INSERT INTO stay_prices (arrival_date, departure_date, total_czk) VALUES ('2026-12-29', '2027-01-02', 29900) ON CONFLICT(arrival_date, departure_date) DO UPDATE SET total_czk = excluded.total_czk;"

# Odstranění (termín se vrátí k ceně po nocích)
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "DELETE FROM stay_prices WHERE arrival_date = '2026-12-29' AND departure_date = '2027-01-02';"

# Výpis
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "SELECT * FROM stay_prices ORDER BY arrival_date, departure_date;"
```

`departure_date` je den odjezdu (poslední noc je noc před ním). Pevná cena se použije jen při
přesné shodě obou dat; pobyt delší než 30 nocí nebo mimo horizont 365 dní neprojde validací termínu.

Cenu konkrétního termínu ověří `POST /api/quote`. Výchozí cena za noc je v kódu
(`PRICE_PER_NIGHT`) – její změna znamená nový deploy. Web cenu nepočítá, zobrazuje `totalCzk` z `POST /api/quote`.

### Vlastní rezervace vrácená exportem e-chalup

Až e-chalupy naimportují rezervaci z webu, objeví se v jejich exportu. Při kontrole
existující rezervace (`findExternalConflict(…, exclude)`) se taková událost nepovažuje
za kolizi se sebou samotnou, pokud nese stejné iCal UID nebo veřejný kód rezervace v
`SUMMARY`/`DESCRIPTION` (`RESERVATION_CODE`: starší `CV-XXXXXX` kdekoli, kód `DDMMYYNN` jen
v kontextu našeho exportu – `Web 10102602`, `Kód rezervace: 10102602`, `z webu 10102602`, aby
se za kód nepovažovalo libovolné osmimístné číslo).

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
  `notified_at IS NULL` přijde správci interní e-mail `POZOR: kolize rezervace DDMMYYNN` s kódem
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
  - `SUMMARY` `Web DDMMYYNN – Jméno Příjmení` (starší rezervace `Web CV-XXXXXX – …`),
  - `DESCRIPTION` s kódem rezervace, hostem, telefonem, e-mailem, počtem hostů, cenou, VS
    a stavem platby; vyplněná poznámka hosta je na konci jako blok `Poznámka hosta:` a text. Tyto údaje se do e-chalup přenesou v poznámce rezervace (ověřeno
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

  Site key widgetu je veřejný: proměnná `TURNSTILE_SITE_KEY` (ve `vars`, ne secret), kterou
  frontend dostane z `GET /api/booking-config`. Preview má testovací Invisible site key
  Cloudflare `1x00000000000000000000BB` (vždy projde, nic nezobrazuje, patří k testovacímu
  secretu `1x…AA`). Produkce site key zatím nemá – formulář se tam nenabízí. Pro zapnutí
  v produkci je potřeba widget v režimu **Invisible** (site key do `vars`, secret přes
  `wrangler secret put`) a odkaz na Cloudflare Turnstile Privacy Addendum v zásadách ochrany
  osobních údajů webu (podmínka režimu Invisible).

## Architektura

```
app/
  layout.tsx            HTML kostra, metadata
  page.tsx              obsah stránky
  globals.css           styly webu včetně kalendáře
components/booking/
  BookingSection.tsx    společný stav pobytu (kalendář + panel), WebMCP nástroj
  AvailabilityCalendar.tsx  navigace, responzivní počet měsíců, klávesnice, legenda (skrytá za „Co znamenají barvy?“ ve slotu s pevnou výškou), stav dat
  CalendarMonth.tsx     mřížka jednoho měsíce
  BookingPanel.tsx      zelený panel: data, hosté, cena ze serveru, poptávka / pokračování k rezervaci
  DateField.tsx, dateInput.ts  vstup data DD.MM.RRRR ↔ ISO (rozepsaný text, validace, picker)
  BookingForm.tsx       kontaktní část, odeslání, potvrzení
  Turnstile.tsx, invisibleTurnstile.ts  Invisible Turnstile (token až při odeslání, čerstvý widget pro každý token)
  reservation.ts, useReservation.ts  POST /api/reservations: request, Idempotency-Key, stavy, chyby
  bookingConfig.ts      GET /api/booking-config (fail-closed = formulář vypnutý)
  useAvailability.ts    načítání /api/availability
  quote.ts, useQuote.ts cenová nabídka z /api/quote (zrušení starších požadavků, stav načítání a chyb)
  quoteView.ts          co panel zobrazí pro nabídku (nightly / exact-stay, sleva, chybové hlášky)
  stayErrors.ts         kód chyby výběru / stav dne → překladový klíč
  config.ts             kapacita, odkaz na poptávku
components/
  I18nProvider.tsx      aktuální jazyk celého webu (volba, persistence, lang/title/description)
  LanguageSwitcher.tsx  přepínač CS / EN / DE / UA
  i18n.ts               useI18n(), useSetLocale()
lib/i18n/
  index.ts              jazyky, createI18n(): t(), plural(), Intl formát dat, měsíců a ceny
  types.ts              typy klíčů odvozené z češtiny (MessageKey, Messages)
  preference.ts         volba jazyka (?lang → localStorage → cs), adresa s jazykem
  messages/             katalogy cs.ts (vzor), en.ts, de.ts, ua.ts
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
    pricing.ts          jediný výpočet ceny (pevná cena pobytu, ceník nocí z D1, slevy, zaokrouhlení)
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
scripts/d1-migrations.ts      kontrola (před deployem) a ruční aplikace D1 migrací
scripts/smoke.ts              smoke test veřejných endpointů po nasazení
scripts/lib/                  logika obou skriptů (testovaná v tests/)
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

## Nasazení a migrace D1

Nasazení zajišťuje Cloudflare Workers Builds napojené na tento repozitář. Migrace D1 se
**nikdy nespouštějí automaticky** – build je jen kontroluje a při nesouladu nasazení zastaví.

### Nastavení Workers Builds

Workers & Pages → `chalupa-vsetice-web` → Settings → Build:

| Nastavení | Hodnota |
|---|---|
| Root directory | `/` |
| Build command | `pnpm run build` |
| Deploy command (větev `main`) | `pnpm run deploy` |
| Preview command (ostatní větve, PR) | `pnpm run deploy:preview` |
| Build variables | `NODE_VERSION=24.19.0`, `PNPM_VERSION=11.25.0` |
| API token | `chalupa-vsetice-web build token` (vlastní user token, viz níže) |

- `pnpm run deploy` = `check production` → `wrangler deploy`.
- `pnpm run deploy:preview` = `check preview` → `wrangler preview` (Worker Previews s blokem
  `previews` a testovací D1).
- Kontrola (`scripts/d1-migrations.ts check`) jen čte a deploy zastaví (build skončí chybou,
  běží dál předchozí verze), když:
  - cílové D1 chybí některá migrace z `migrations/` (kód by běžel nad starým schématem),
  - `meta.environment` v DB neodpovídá prostředí (špatná databáze),
  - konfigurace není konzistentní (produkce a Preview sdílejí D1, `wrangler.preview-migrations.jsonc`
    ukazuje jinam než `previews`, v produkci je `BOOKING_API_ENABLED`),
  - stav D1 nejde přečíst (chybí oprávnění, výpadek API) – **fail-closed**.

  Migrace, které jsou v DB, ale kód je nezná (rollback na starší commit, jiná větev), jsou jen
  varování – proto musí být každá migrace zpětně kompatibilní s předchozí verzí kódu.

**API token pro build.** Automaticky generovaný token Workers Builds nemá oprávnění k D1,
kontrola by s ním vždy selhala. Vytvoř user token (My Profile → API Tokens) s oprávněními:

- Account: Account Settings – Read, Workers Scripts – Edit, **D1 – Read**
  (a Workers KV Storage / R2 Storage – Edit jen pokud je projekt začne používat),
- Zone: Workers Routes – Edit,
- User: User Details – Read, Memberships – Read,

a nastav ho v Settings → Build → API token (Production i Previews). **D1 jen Read** – build
tak migrace nemůže aplikovat ani omylem.

**Aktuální stav (nastaveno ručně v dashboardu, není v repozitáři):** Production i Previews
používají výše uvedené příkazy a token `chalupa-vsetice-web build token` (scope: jen účet
projektu a zóna `chalupavsetice.cz`); Preview branches jsou zapnuté. Kontrola migrací tedy
běží před každým deployem i před každým Worker Preview. Hodnota tokenu se nikde nevypisuje
ani neukládá do repozitáře. Při výměně tokenu musí nový token mít stejná oprávnění, jinak
build skončí chybou (fail-closed).

### Postup změny s migrací

1. PR s novou migrací `migrations/NNNN_nazev.sql` (souvislé číslování; kontroluje test).
   Preview build PR selže, dokud migrace není na testovací D1 – to je záměr.
2. Testovací D1: `pnpm run db:migrate:preview` → Preview build znovu spustit (retry) a ověřit.
3. Review PR.
4. Produkční D1 – vědomé schválení: `pnpm run db:migrate:production`
   - jen v interaktivním terminálu (v CI a buildu se odmítne),
   - vypíše čekající migrace a označí destruktivní,
   - vyžaduje opsat název databáze `chalupa-vsetice-rezervace`.
5. Merge do `main` → build: kontrola projde → deploy.
6. Smoke test: `pnpm run smoke https://chalupavsetice.cz --env production`.

Když se merge provede před krokem 4, produkční build skončí chybou a web dál běží na předchozí
verzi; stačí doplnit krok 4 a build zopakovat.

Migrace musí být **zpětně kompatibilní** s předchozí verzí kódu:

- Mezi krokem 4 a dokončením deploye v kroku 5 běží **starý kód nad novým schématem**.
- Rollback kódu (návrat na starší commit) schéma nevrací – starší kód pak běží nad novějším
  schématem. Rollback schématu se automaticky nedělá; Time Travel je jen nouzová obnova celé DB
  (včetně ztráty novějších dat).
- Bezpečné: nový nullable sloupec (nebo sloupec s výchozí hodnotou), nová tabulka, nový index.
- Breaking změny (smazání nebo přejmenování sloupce či tabulky, změna typu nebo významu dat)
  se dělají **vícefázově**: nejdřív deploy kódu, který starou strukturu nepotřebuje, a až
  v pozdějším PR migrace, která ji odstraní.
- `check` migrace, které jsou v DB, ale kód je nezná, jen varuje – na ochranu po rollbacku
  se proto spoléhat nedá.

### Destruktivní migrace

Za destruktivní se považuje migrace s `DROP`, `ALTER TABLE … DROP COLUMN / RENAME`, `DELETE`,
`UPDATE` nebo `REPLACE` (mimo těla `CREATE TRIGGER`, komentáře a řetězce; v pochybnostech
konzervativně ano). U produkce `db:migrate:production` navíc:

1. zjistí Time Travel bookmark aktuálního stavu (`wrangler d1 time-travel info`) a vypíše
   příkaz pro obnovu,
2. vyexportuje celou DB (`wrangler d1 export`) do `.d1-backups/` a ověří, že export není prázdný,
3. vyžaduje opsat frázi `ZALOHA OVERENA`.

Bez bookmarku, exportu nebo fráze se migrace neaplikuje. Před potvrzením export otevři
a zkontroluj. **`.d1-backups/` obsahuje osobní údaje hostů:** je v `.gitignore`, nikam ho
nenahrávej a po ověření migrace ho smaž.

Obnova při problému:

```bash
# Celá DB do stavu před migrací (Time Travel, bookmark z výpisu migrace)
npx wrangler d1 time-travel restore chalupa-vsetice-rezervace --bookmark=<bookmark>
```

Pak vrátit kód na verzi odpovídající schématu. Time Travel uchovává historii 30 dní (Workers
Paid) / 7 dní (Free).

### Ruční příkazy

```bash
pnpm run db:check:preview          # stav testovací D1 (jen čtení)
pnpm run db:check:production       # stav produkční D1 (jen čtení)
pnpm run db:migrate:preview        # aplikace na testovací D1
pnpm run db:migrate:production     # aplikace na produkční D1 (potvrzení, u destruktivních záloha)
```

Vyžadují přihlášení (`npx wrangler login`) nebo `CLOUDFLARE_API_TOKEN`. Pod kapotou je
`wrangler d1 … --remote`; `wrangler d1` čte jen top-level `d1_databases`, proto testovací DB
používá `wrangler.preview-migrations.jsonc` (stejné ID jako `previews.d1_databases`, jen pro
`wrangler d1`, ne pro deploy – kontroluje to `check`).

Nová databáze potřebuje před první kontrolou označení prostředí:

```bash
npx wrangler d1 execute chalupa-vsetice-rezervace-test --remote --config wrangler.preview-migrations.jsonc \
  --command "INSERT INTO meta (key, value) VALUES ('environment', 'preview')"
npx wrangler d1 execute chalupa-vsetice-rezervace --remote \
  --command "INSERT INTO meta (key, value) VALUES ('environment', 'production')"
```

### Secrets pro Worker Previews

Worker Previews nedědí produkční secrets. Sdílené secrets pro všechny Previews se nastavují
v Preview base config (hodnotu zadává wrangler interaktivně, nikdy ji nevypisovat):

```bash
npx wrangler preview base-config secret put ECHALUPY_ICAL_URL
npx wrangler preview base-config secret put BOOKING_ICAL_EXPORT_TOKEN   # jiný token než v produkci
npx wrangler preview base-config secret put TURNSTILE_SECRET_KEY        # testovací klíč Cloudflare
npx wrangler preview base-config secret put PAYMENT_IBAN                # český IBAN pro platby rezervací
npx wrangler preview base-config secret list                            # jen názvy
```

- `ECHALUPY_ICAL_URL` – bez něj Preview ukáže obsazenost jako nedostupnou (smoke test selže).
- `BOOKING_ICAL_EXPORT_TOKEN` – export je v Preview zapnutý (`BOOKING_ICAL_EXPORT_ENABLED`);
  bez tokenu je „nenakonfigurovaný“ a `/api/reservations.ics` vrací 503. Smoke test očekává
  nakonfigurovaný export, který bez předloženého tokenu vrací 404.
- `TURNSTILE_SECRET_KEY` – bez něj zapnutý rezervační POST v Preview vrací 503 `not-configured`.
- `PAYMENT_IBAN` – bez něj (nebo s neplatnou hodnotou) zapnutý rezervační POST v Preview vrací
  503 `not-configured` a rezervaci nezaloží (smoke test selže). Hodnota se nikdy nevypisuje
  ani necommituje; ověřuje se jen názvem (`secret list`) a chováním endpointu. Produkční
  `npx wrangler secret put PAYMENT_IBAN` bude potřeba až při zapnutí produkčního POST.
- Volitelně `BOOKING_API_TOKEN`, `RESEND_API_KEY`, `CONFLICT_ALERT_EMAIL`.

`npx wrangler preview secret put <KEY>` (bez `base-config`) nastaví secret jen **jednomu**
Preview (výchozí název = aktuální git větev) – další PR Previews ho nedostanou.

### Smoke test

```bash
pnpm run smoke https://chalupavsetice.cz --env production
pnpm run smoke https://<preview-url> --env preview
```

Ověří web, `/api/availability` (status, žádné osobní údaje), `/api/quote` (platný i neplatný
termín, 405), `POST /api/reservations` (**v produkci musí vrátit 404**; nikde nesmí přijmout
prázdný požadavek), `/api/booking-config` (v produkci `bookingEnabled: false`, v Preview zapnutý
s veřejným site key), `/api/reservations.ics` bez tokenu (404) a neznámé API (404 JSON
s bezpečnostními hlavičkami). Exit 1 při selhání; `stale`/`partial` obsazenost je jen varování.

Nepoužívá žádné tokeny ani secrets: přijme jen origin (https, http jen localhost) bez cesty,
query a přihlašovacích údajů, neposílá `Authorization` ani cookies a nic nezapisuje (rezervační
POST jde bez údajů, nabídka je jen čtení).
