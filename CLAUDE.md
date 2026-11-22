# Chalupa Všetice – pravidla pro Claude Code

Web chalupy na Cloudflare Workers (statické assety + Worker pro `/api/*` a `/calendar/*`) s rezervačním
backendem v D1. Podrobný technický a provozní popis je v `README.md`; tady jsou pravidla, která
platí v každé session.

## Produkční bezpečnost

- Produkční `POST /api/reservations` je **vypnutý** a zůstává vypnutý, dokud o zapnutí výslovně
  nerozhodne uživatel. Nikdy ho nezapínat v rámci jiného PR.
- `BOOKING_API_ENABLED` nesmí být v produkční konfiguraci (top-level `vars` ve `wrangler.jsonc`);
  je jen v bloku `previews`. Hlídá to `scripts/d1-migrations.ts check` i smoke test.
- Produkční deploy jen přes merge do `main` (Workers Builds: `check production` → deploy).
  Nikdy nespouštět `pnpm run deploy` ani `wrangler deploy` přímo. PR mergovat jen s výslovným
  souhlasem uživatele.
- Migrace D1 jen podle pravidel v sekci „D1 a migrace“.

## D1 a migrace

- Migrace se **nikdy neaplikují v CI ani ve Workers Builds**. Mimo build je smí po schválení
  konkrétního nasazení aplikovat agent autorizovaným neinteraktivním režimem, případně
  člověk interaktivně. Build token má
  k D1 jen **Read**: build stav jen kontroluje (`check`) a při nesouladu deploy zastaví.
- Claude migrace aplikuje **jen** neinteraktivním autorizovaným režimem skriptu (TTY ochranu
  interaktivního režimu nikdy neobcházet, žádné podvržení terminálu):
  `pnpm run db:migrate:<preview|production> --non-interactive --database=<název DB>
  --expect=<přesný seznam čekajících migrací> [--allow-destructive=<migrace>]`.
  Nevymýšlet vlastní varianty `wrangler d1 migrations apply`, `d1 execute` se zápisem ani
  `time-travel restore`.
- Kdy smí Claude migraci aplikovat:
  - **Preview, aditivní:** samostatně, když PR přidává migraci (Preview build do té doby záměrně
    selhává).
  - **Produkce, aditivní:** jen když uživatel schválil nasazení daného PR (souhlas s mergem);
    vždy před mergem, s ověřenou zálohou (skript ji vynutí) a s `--expect` přesně podle
    `db:check:production`.
  - **Destruktivní (Preview i produkce):** jen po výslovném souhlasu uživatele s konkrétní
    migrací; v produkci samostatně (skript vynutí), s ověřenou zálohou.
  - Jakákoli chyba (check, autorizace, záloha, aplikace, kontrola po aplikaci) = zastavit
    a popsat; nic neopakovat jinou cestou.
- Postup PR s migrací `migrations/NNNN_nazev.sql`:
  1. `pnpm run db:check:preview` → Preview migrace (neinteraktivně, viz výše),
  2. ověřit Preview (retry buildu, `pnpm run smoke <preview-origin> --env preview`),
  3. po souhlasu s nasazením: `pnpm run db:check:production` → produkční migrace
     (neinteraktivně, `--expect` = čekající migrace) → `pnpm run db:check:production`,
  4. merge do `main` (build: `check production` → deploy) a ověření buildu,
  5. po deployi `pnpm run smoke https://chalupavsetice.cz --env production`,
  6. uživateli předat Time Travel bookmark z výpisu zálohy; `.d1-backups/` po ověření smazat.
- Stav k 22. 11. 2026: PR #41 a #40 mergnuté, produkční D1 má migrace `0001`–`0010`,
  produkční smoke test prošel 10/10. Migrace `0009` a `0010` neopakovat; další aplikace
  vždy vychází ze skutečného `db:check`. Rezervační POST v produkci zůstává vypnutý.
- Obnova (`wrangler d1 time-travel restore`) maže novější data – jen na výslovný pokyn uživatele.
  Time Travel má časově omezenou retenci; SQL export v dočasné cloudové session je po
  ověření mazán. Jde o pojistku pro migraci, ne dlouhodobý archiv záloh.
- Příkazy: `pnpm run db:check:preview`, `pnpm run db:check:production`,
  `pnpm run db:backup:preview`, `pnpm run db:backup:production`,
  `pnpm run db:migrate:preview`, `pnpm run db:migrate:production` (+ autorizace výše),
  `pnpm run smoke <origin> --env production|preview` (v cloudové session s
  `NODE_USE_ENV_PROXY=1`; wrangler s `CLOUDFLARE_API_TOKEN=proxy-injected`, skutečný token
  doplňuje proxy).
- Číslování migrací je souvislé (`0001`, `0002`, …); kontroluje to test.
- Triggery v migracích na jednom řádku (testovací D1 dělí migrace podle `;` na konci řádku).

### Zpětná kompatibilita migrací

- Mezi aplikací produkční migrace a dokončením deploye běží **starý kód nad novým schématem**.
- Při rollbacku kódu zůstává nové schéma a běží starší kód. Rollback schématu se nedělá.
- Každá migrace proto musí být zpětně kompatibilní s předchozí verzí kódu:
  - přidat nullable sloupec, novou tabulku, nový index – v pořádku,
  - smazat, přejmenovat sloupec/tabulku, změnit typ nebo význam dat – rozdělit do více
    deployů (nejdřív kód, který starou věc nepoužívá, až pak migrace, která ji odstraní).
- `check` migrace, které jsou v DB, ale kód je nezná, jen **varuje** – na ochranu proti
  nekompatibilnímu schématu po rollbacku se nespoléhat.
- Každá produkční migrace (aditivní i destruktivní) vyžaduje ověřenou zálohu –
  `db:migrate:production` ji vynutí (Time Travel bookmark + export do `.d1-backups/`, ověření
  schématu a záznamů migrací). Destruktivní (`DROP`, `DELETE`, `UPDATE`, `RENAME`, `REPLACE`)
  mají přísnější režim: výslovné povolení, v produkci samostatně.

## Automatické zálohy D1 (R2)

- Samostatný Worker `chalupa-vsetice-d1-backup` (`wrangler.backup.jsonc`, `worker/backup/`):
  Workflow přes `workflows[].schedules` (02:15 UTC záloha, 14:45 UTC kontrola), export D1 REST
  API → soukromý R2 `chalupa-vsetice-d1-backups`. Doplňuje ruční zálohy před migracemi
  (`db:backup:*`), nenahrazuje je. Popis: README, „Automatické zálohy D1“.
- Nasazení jen `pnpm run backup:deploy` a jen s výslovným souhlasem uživatele (Workers Builds ho
  nenasazuje). Testovací prostředí (`pnpm run backup:deploy:test`, Preview D1 → testovací
  bucket) smí Claude nasadit a spouštět samostatně.
- Export vždy `dump_options.compatibility: "d1"` (obnovitelný); nikdy `sqlite3_cli_only`.
- Snapshoty (`daily/`, `monthly/`) se zapisují jen podmíněně (`If-None-Match: *`) – nikdy
  nepodmíněný `put()` ani mazání existujícího snapshotu kvůli zápisu nového.
- Retence podle počtu (30 denních, 12 měsíčních) až po úspěšné záloze; lifecycle R2 jen pro
  `pending/`. Jen R2 Standard, žádný Infrequent Access. Strop exportu 150 MiB, tvrdý strop
  bucketu 9 GB a upozornění nad 7 GB neměnit bez souhlasu. Netvrdit absolutní záruku nulových
  nákladů (kvóta R2 je společná pro účet). Žádný placený tarif ani změna billingu bez souhlasu
  uživatele.
- Upozornění jsou v produkci povinná (`RESEND_API_KEY`, `CONFLICT_ALERT_EMAIL`); bez nich
  instance končí chybou. Před produkčním nasazením ověřit doručení `{"mode":"alert-test"}` –
  jen na správcovskou adresu, nikdy hostům.
- Bucket nikdy neveřejný (žádná vlastní doména, žádné `r2.dev`). Zálohy nikam mimo R2.
- Do logů, výsledků kroků Workflow, PR ani výstupů nikdy token, podepsanou URL, obsah SQL ani
  osobní údaje. Stažený snapshot (osobní údaje) jen dočasně mimo repozitář a po použití smazat.
- Do produkční D1 se nikdy neimportuje ani ji nic nepřepisuje. Obnova produkce (Time Travel nebo
  přepnutí na obnovenou D1) jen na výslovný pokyn uživatele; zkušební obnovy jen do nové
  samostatné D1, kterou je po ověření potřeba smazat.

## Cloudflare konfigurace mimo git

Skutečný stav (nastaveno ručně v dashboardu, v diffu není vidět):

- Workers & Pages → `chalupa-vsetice-web` → Settings → Builds:
  - Production: build `pnpm run build`, deploy `pnpm run deploy`, root `/`.
  - Previews: Preview branches zapnuté, build `pnpm run build`, preview command
    `pnpm run deploy:preview`, root `/`.
  - API token: vlastní user token `chalupa-vsetice-web build token` (Account Settings Read,
    Workers Scripts Edit, D1 **Read**; Workers Routes Edit pro zónu `chalupavsetice.cz`; User
    Details Read, Memberships Read).
- Token pro správu D1 (záloha a migrace, mimo build): samostatný user token s Account Settings
  Read, **D1 Edit**, User Details Read, Memberships Read; v cloudové session Claude ho doplňuje
  proxy pro `api.cloudflare.com`. Build token zůstává D1 **Read** – nikdy ho nerozšiřovat.
- Zálohovací Worker (`wrangler.backup.jsonc`): secrets `D1_EXPORT_API_TOKEN` (samostatný user
  token **B** jen Account → D1 → Edit; D1 nejde omezit na jednu databázi), `D1_EXPORT_ACCOUNT_ID`,
  `RESEND_API_KEY`, `CONFLICT_ALERT_EMAIL` (v produkci povinné), volitelně `CONFLICT_ALERT_FROM`
  – přes `wrangler secret put … --config wrangler.backup.jsonc [--env test]` nebo dashboard.
  Nikdy jako secret nepoužít administrátorský token ani token pro správu.
- Token **A** pro správu zálohovací infrastruktury (Claude): Workers R2 Storage Edit, Workers
  Scripts Edit, Account Settings Read, User Details Read, Memberships Read (+ D1 Edit pro
  migrace). Oprávnění jsou na úrovni účtu – Workers Scripts Edit technicky dovolí měnit i
  rezervační Worker; ten Claude přímo nenasazuje (jen přes merge). R2 musí být na účtu
  aktivované (dashboard, rozhodnutí uživatele).
- Secrets se nastavují jen přes `wrangler secret put` (produkce) a
  `wrangler preview base-config secret put` (sdílené všem Worker Previews). Preview potřebuje
  minimálně `ECHALUPY_ICAL_URL`, `BOOKING_ICAL_EXPORT_TOKEN`, `TURNSTILE_SECRET_KEY`
  (testovací klíč Cloudflare) a `PAYMENT_IBAN`; bez `BOOKING_ICAL_EXPORT_TOKEN` vrací
  `/api/reservations.ics` v Preview 503 a smoke test selže, bez platného `PAYMENT_IBAN` vrací
  rezervační POST 503 `not-configured` (fail closed). Potvrzovací e-mail v Preview potřebuje
  `RESEND_API_KEY` a `BOOKING_CONFIRMATION_TEST_EMAIL` a jde **jen** na tuto testovací schránku,
  nikdy na adresu hosta; selhání e-mailu je nefatální (rezervace i odpověď 201 zůstávají).
  Odesílatel je `BUSINESS_NAME <BUSINESS_EMAIL_RESERVATIONS>` z `lib/business.ts` (doména
  musí být ověřená v Resend, i pro Preview). Selhání providera generuje best-effort interní upozornění
  na `CONFLICT_ALERT_EMAIL` jen s kódem rezervace, prostředím, druhem chyby a časem – nikdy
  s osobními nebo bankovními údaji.
- Hodnoty tokenů a secrets **nikdy** nevypisovat, necommitovat, nedávat do PR, logů ani výstupů
  testů. Ověřovat jen podle názvu (`wrangler secret list`) nebo chování endpointu.

## Zdroj pravdy: backend

- Backend je jediný zdroj pravdy pro cenu, slevy, exact-stay ceny, dostupnost a validaci
  rezervace (`worker/booking/pricing.ts`, `validation.ts`, `/api/availability`).
- Frontend nesmí duplikovat business logiku: jen sbírá vstupy, volá backend (`POST /api/quote`,
  `POST /api/reservations`, `GET /api/availability`) a zobrazuje/formátuje výsledek.
- Cena na frontendu se **nepočítá** jako počet nocí × výchozí cena; zobrazuje se `totalCzk`
  z `/api/quote` a podle `pricingMode` (`nightly` / `exact-stay`) případně rozpis nocí.
  Před výběrem termínu smí panel jen zobrazit orientační „Běžně … / noc“ z `PRICE_PER_NIGHT`
  (`lib/booking/rules.ts`, výchozí cena serveru) přes `formatPrice` – bez výpočtu a bez pevné částky.
- Frontend je vícejazyčný (cs, en, de, ua – `lib/i18n`): žádné pevné texty v komponentách
  (ani `aria-label`/`alt`), každý nový klíč do všech čtyř katalogů (tsc to vynutí), formátování
  přes `Intl`. Jazyk a měna jsou oddělené (vždy CZK). API vrací jen stabilní kódy (`error`), ne texty.
- Data v UI vždy den → měsíc → rok (vstup `DD.MM.RRRR`, i v angličtině nikdy měsíc/den); interně
  a v API jen ISO `YYYY-MM-DD`.
- Rezervační formulář se nabízí jen podle `GET /api/booking-config` (`bookingEnabled`); produkce
  zůstává na poptávce přes e-chalupy, dokud o zapnutí nerozhodne uživatel.
- Potvrzovací e-mail i kalendář jsou v produkci nasazené, ale nové hostovské rezervace
  vznikají jen v Preview. `calendarUrl` skládá server (`GET /calendar/<token>`, bez `.ics`
  v URL); e-mail obsahuje stejnou událost jako přílohu `pobyt.ics` pro rozpoznání Siri.
  URL i příloha jsou jednorázový import, nikoli automatická aktualizace události.

## Identita provozovatele

- Jméno, telefon, IČ, hlavní web, info e-mail a odesílatel rezervací jsou jen
  v `lib/business.ts` (šest hodnot `BUSINESS_*`, nejde o secrets). Šablony a renderery je
  nesmí zapisovat napevno; pro jiný objekt se mění jen tyto hodnoty.
- V e-mailu je `IČ: …` prostý text (žádný odkaz na rejstřík); odkazy jen na vlastní web
  (`BUSINESS_WEBSITE_URL`), `mailto:` info e-mailu a `tel:`.

## Secrets a data

- `ECHALUPY_ICAL_URL` ani jiné soukromé URL nikdy do repozitáře, README, PR, commitů, testů
  ani klientského JS; žádné `NEXT_PUBLIC_*` pro tajné hodnoty.
- Repozitář je veřejný: žádný skutečný bankovní účet, IBAN ani jméno majitele účtu v kódu,
  README, testech, komentářích, PR ani logách. Účet je jen v secretu `PAYMENT_IBAN`; testy
  používají fiktivní účet banky `9999` (`tests/helpers.ts`), `tests/payment.test.ts` to hlídá.
- Testy a ruční ověřování jen se syntetickými daty (rok 2030, domény `.invalid`).
- Osobní údaje hostů a obsah poznámek se nelogují a nejsou ve veřejných odpovědích.
  Calendar URL je neveřejný odkaz s náhodným tokenem: kód ho výslovně neloguje, ale
  platformní invocation logs mohou ukládat cestu požadavku. `redact_query_string`
  neskryje token obsažený v URL cestě; obsah ICS nesmí obsahovat PII.
- `.d1-backups/` obsahuje osobní údaje: je v `.gitignore`, nikam se nenahrává a po ověření
  migrace se smaže.

## Git a PR

- Autor commitů `Hype-Cloud`; commit messages, PR popisy a PR komentáře česky,
  profesionálním neosobním technickým stylem; bez zmínek o AI a bez
  `Co-Authored-By` trailerů.
- Malé, logicky oddělené PR; nemíchat nesouvisející úklid do feature PR.
- PR nemergovat bez souhlasu uživatele.
- Před PR: `pnpm test`, `pnpm run build`, `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc`
  (`tsc --noEmit` má jednu známou chybu ve `vite.config.ts`, mimo rozsah).

### Styl PR popisů a komentářů

- PR popisy, review komentáře a technické poznámky psát jako profesionální projektovou
  dokumentaci, ne jako konverzaci s uživatelem.
- Nepoužívat první osobu typu „udělal jsem“, „přidal jsem“, „změnil jsem“, „ověřil jsem“.
- Preferovat věcný, neosobní styl, například:
  - „Přidána validace…“
  - „Implementace používá…“
  - „Změna zachovává…“
  - „Testy ověřují…“
  - „Produkční POST zůstává vypnutý.“
- Nevkládat do PR popisu konverzační fráze typu:
  - „Jak jsme se domluvili…“
  - „Tady je…“
  - „Ještě jsem…“
  - „Můžeš teď…“
  - „Doporučuji…“
- PR popis musí být čitelný i pro vývojáře, který neviděl předchozí chat ani zadání.
- Struktura PR popisu má podle relevance standardně používat sekce:
  - `## Shrnutí`
  - `## Implementace`
  - `## Chování / důležité scénáře`
  - `## Testování`
  - `## Bezpečnost / provozní dopad`
- Popisovat stav repozitáře a výslednou změnu, ne průběh práce autora.
- Neuvádět zbytečné narativní detaily o tom, jak implementace vznikala.
- Technická tvrzení formulovat přesně a ověřitelně; nepsat marketingově ani přehnaně
  sebejistě.
- PR komentáře k testům nebo opravám psát stejným věcným stylem; místo
  „Otestoval jsem to a funguje to“ použít například
  „Ověřeno v Preview: 10/10 smoke kontrol úspěšných.“
