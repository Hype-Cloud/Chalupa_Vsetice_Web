# Chalupa Všetice – web

Prezentační web rekreační chalupy ve Všeticích. Web vznikl v ChatGPT Sites a byl
převzat do tohoto repozitáře beze změny designu.

- Testovací adresa: https://chalupa-vsetice-web.gamemanlpvlogs.workers.dev/
- Produkční doména (zatím nepřipojena): chalupavsetice.cz

## Technologie

- React 19 + [vinext](https://github.com/cloudflare/vinext) (Next.js App Router API nad Vite)
- Statický export (`output: "export"`) – žádný server, databáze ani API
- Hosting: Cloudflare Workers Static Assets
- Package manager: pnpm 11 (`pnpm-lock.yaml`), Node.js 24 (`.node-version`)

## Struktura

| Cesta | Obsah |
|---|---|
| `app/page.tsx` | Celá stránka včetně vložení kalendáře e-chalupy |
| `app/globals.css` | Styly webu |
| `app/layout.tsx` | HTML kostra, titulek, meta popis, favicon |
| `public/chalupa.jpg` | Fotografie chalupy |
| `public/calendar.css` | Vlastní CSS kalendáře e-chalupy (načítá se přes `extCss`) |
| `scripts/finalize-static.mjs` | Po buildu odstraní serverovou část, nasazuje se jen `dist/client` |
| `components/ui/`, `lib/` | Knihovna shadcn/ui ze Sites – na stránce zatím nepoužitá |

## Rezervace

Centrálním rezervačním systémem je e-chalupy.cz. Web nemá vlastní rezervační backend:

- Kalendář obsazenosti je iframe `obsazenost.e-chalupy.cz` (objekt `id=19216`).
- Vzhled kalendáře upravuje `public/calendar.css`, který e-chalupy načítají z jsDelivr:
  `https://cdn.jsdelivr.net/gh/Hype-Cloud/Chalupa_Vsetice_Web@main/public/calendar.css`.
  Změna tohoto souboru na větvi `main` se projeví v kalendáři i bez nového buildu
  (CDN jsDelivr může mít prodlevu až několik hodin).
- Tlačítko „Poptat na e-chalupy“ vede na profil chalupy na e-chalupy.cz.
- Kalkulačka v panelu „Vaše dovolená“ počítá pouze orientační cenu (3 000 Kč / noc).

## Vývoj

```bash
pnpm install
pnpm dev          # lokální vývojový server
pnpm run build    # produkční build do dist/client
pnpm preview      # lokální náhled přes wrangler dev
```

Projekt nepotřebuje žádné proměnné prostředí ani tajné klíče.

## Nasazení (Cloudflare Workers Builds)

Push do větve `main` automaticky spustí build a nasazení Workeru `chalupa-vsetice-web`.

| Nastavení | Hodnota |
|---|---|
| Root directory | `/` |
| Build command | `pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| Výstup (`wrangler.jsonc` → `assets.directory`) | `./dist/client` |
| Build variables | `NODE_VERSION=24.19.0`, `PNPM_VERSION=11.25.0` |
