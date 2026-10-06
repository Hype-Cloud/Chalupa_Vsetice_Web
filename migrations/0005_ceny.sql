-- Ceny pobytu: individuální cena konkrétní noci a množstevní slevy podle délky pobytu.
-- Výpočet je jen na serveru (worker/booking/pricing.ts); noc bez řádku v daily_prices má
-- výchozí cenu PRICE_PER_NIGHT (lib/booking/rules.ts). Správa zatím přes wrangler d1 execute,
-- budoucí admin bude jen CRUD nad těmito tabulkami.

-- Cena noci začínající dnem `date` (YYYY-MM-DD), celé Kč.
CREATE TABLE daily_prices (
  date      TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  price_czk INTEGER NOT NULL CHECK (typeof(price_czk) = 'integer' AND price_czk > 0 AND price_czk <= 1000000)
);

-- Množstevní sleva: pro pobyt se použije pravidlo s nejvyšším min_nights <= počet nocí.
-- Procenta jsou celá čísla 0–100; každý práh nejvýš jednou.
CREATE TABLE length_discounts (
  id               INTEGER PRIMARY KEY,
  min_nights       INTEGER NOT NULL UNIQUE CHECK (typeof(min_nights) = 'integer' AND min_nights >= 1),
  discount_percent INTEGER NOT NULL CHECK (typeof(discount_percent) = 'integer' AND discount_percent BETWEEN 0 AND 100)
);
