-- Pevná celková cena pro přesně daný pobyt (příjezd + odjezd), např. Silvestr 29. 12. → 2. 1.
-- Je to jen cenové pravidlo, ne omezení rezervací: jiný termín pravidlo ignoruje a nic neblokuje.
-- Při přesné shodě má přednost před daily_prices, výchozí cenou i length_discounts
-- (worker/booking/pricing.ts). Bez názvů a metadat balíčků – budoucí balíčky nebo omezení
-- mohou na dvojici (arrival_date, departure_date) odkazovat z vlastních tabulek.

-- date(x) IS x odmítne neexistující datum (2026-02-30), IS místo = kvůli NULL.
-- Horní limit = 30 nocí × maximální cena noci z daily_prices.
CREATE TABLE stay_prices (
  arrival_date   TEXT NOT NULL CHECK (arrival_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(arrival_date) IS arrival_date),
  departure_date TEXT NOT NULL CHECK (departure_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(departure_date) IS departure_date),
  total_czk      INTEGER NOT NULL CHECK (typeof(total_czk) = 'integer' AND total_czk > 0 AND total_czk <= 30000000),
  PRIMARY KEY (arrival_date, departure_date),
  CHECK (departure_date > arrival_date)
);
