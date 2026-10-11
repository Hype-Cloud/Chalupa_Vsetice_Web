# Chalupa Všetice – pravidla pro Claude Code

Web chalupy na Cloudflare Workers (statické assety + Worker pro `/api/*`) s rezervačním
backendem v D1. Podrobný technický a provozní popis je v `README.md`; tady jsou pravidla, která
platí v každé session.

## Produkční bezpečnost

- Produkční `POST /api/reservations` je **vypnutý** a zůstává vypnutý, dokud o zapnutí výslovně
  nerozhodne uživatel. Nikdy ho nezapínat v rámci jiného PR.
- `BOOKING_API_ENABLED` nesmí být v produkční konfiguraci (top-level `vars` ve `wrangler.jsonc`);
  je jen v bloku `previews`. Hlídá to `scripts/d1-migrations.ts check` i smoke test.
- Nikdy nespouštět produkční deploy (`pnpm run deploy`, `wrangler deploy`) ani migrace sám.

## D1 a migrace

- Migrace se **nikdy** neaplikují automaticky – ani v CI, ani ve Workers Builds. Build token má
  k D1 jen **Read**: build stav jen kontroluje (`check`) a při nesouladu deploy zastaví.
- Claude nesmí předpokládat, že může aplikovat produkční (ani testovací) migraci. Když PR
  přidává migraci `migrations/NNNN_nazev.sql`, výslovně uživatele proveď:
  1. `pnpm run db:migrate:preview` (Preview build PR do té doby záměrně selhává),
  2. ověřit Preview (retry buildu, `pnpm run smoke <preview-origin> --env preview`),
  3. před mergem `pnpm run db:migrate:production`,
  4. merge do `main` (build: `check production` → deploy),
  5. po deployi `pnpm run smoke https://chalupavsetice.cz --env production`.
- Příkazy: `pnpm run db:check:preview`, `pnpm run db:check:production`,
  `pnpm run db:migrate:preview`, `pnpm run db:migrate:production`,
  `pnpm run smoke <origin> --env production|preview`. Nevymýšlet vlastní varianty
  `wrangler d1 migrations apply`.
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
- Destruktivní produkční migrace (`DROP`, `DELETE`, `UPDATE`, `RENAME`, `REPLACE`) vyžadují
  zálohu – `db:migrate:production` ji vynutí (Time Travel bookmark + export do `.d1-backups/`).

## Cloudflare konfigurace mimo git

Skutečný stav (nastaveno ručně v dashboardu, v diffu není vidět):

- Workers & Pages → `chalupa-vsetice-web` → Settings → Builds:
  - Production: build `pnpm run build`, deploy `pnpm run deploy`, root `/`.
  - Previews: Preview branches zapnuté, build `pnpm run build`, preview command
    `pnpm run deploy:preview`, root `/`.
  - API token: vlastní user token `chalupa-vsetice-web build token` (Account Settings Read,
    Workers Scripts Edit, D1 **Read**; Workers Routes Edit pro zónu `chalupavsetice.cz`; User
    Details Read, Memberships Read).
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

## Identita provozovatele

- Jméno, telefon, IČO, odkaz do rejstříku, info e-mail a odesílatel rezervací jsou jen
  v `lib/business.ts` (šest hodnot `BUSINESS_*`, nejde o secrets). Šablony a renderery je
  nesmí zapisovat napevno; pro jiný objekt se mění jen tyto hodnoty.
- V e-mailu se IČ zobrazuje jen jako odkaz `IČ: …` na `BUSINESS_REGISTER_URL` – bez viditelné
  URL a bez názvu rejstříku.

## Secrets a data

- `ECHALUPY_ICAL_URL` ani jiné soukromé URL nikdy do repozitáře, README, PR, commitů, testů
  ani klientského JS; žádné `NEXT_PUBLIC_*` pro tajné hodnoty.
- Repozitář je veřejný: žádný skutečný bankovní účet, IBAN ani jméno majitele účtu v kódu,
  README, testech, komentářích, PR ani logách. Účet je jen v secretu `PAYMENT_IBAN`; testy
  používají fiktivní účet banky `9999` (`tests/helpers.ts`), `tests/payment.test.ts` to hlídá.
- Testy a ruční ověřování jen se syntetickými daty (rok 2030, domény `.invalid`).
- Osobní údaje hostů a obsah poznámek se nelogují a nejsou ve veřejných odpovědích.
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
  „Ověřeno v Preview: 8/8 smoke kontrol úspěšných.“
