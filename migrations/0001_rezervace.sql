-- Rezervační úložiště (Cloudflare D1). Provozní administrace zůstává v e-chalupách;
-- D1 je jen technické úložiště rezervací z webu.

-- Označení databáze (production / preview). Hodnotu vkládá ručně správce do každé databáze
-- zvlášť; Worker bez shody s proměnnou BOOKING_ENV do databáze nezapisuje.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Čítače. Variabilní symbol se přiděluje ve stejném batchi jako rezervace, takže při
-- neúspěchu (obsazený termín) se čítač vrátí a v řadě nevznikají mezery.
CREATE TABLE sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO sequences (name, value) VALUES ('variable_symbol', 0);

CREATE TABLE reservations (
  id              TEXT PRIMARY KEY,                -- interní UUID
  public_code     TEXT NOT NULL UNIQUE,            -- veřejný kód pro hosta, např. CV-7K3M9Q
  arrival         TEXT NOT NULL CHECK (arrival GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  departure       TEXT NOT NULL CHECK (departure GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND departure > arrival),
  guests          INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 7),
  first_name      TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name       TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  phone           TEXT NOT NULL CHECK (length(phone) BETWEEN 9 AND 20),
  email           TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  price_czk       INTEGER NOT NULL CHECK (price_czk > 0),
  variable_symbol TEXT NOT NULL UNIQUE,
  -- pending_payment = čeká na ruční ověření platby, paid = zaplaceno, cancelled = zrušeno.
  -- Nezaplacené rezervace se automaticky neruší.
  status          TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'paid', 'cancelled')),
  ical_uid        TEXT NOT NULL UNIQUE,            -- stabilní UID pro budoucí iCal export do e-chalup
  ical_sequence   INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,                     -- opakované odeslání stejného požadavku
  request_hash    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Obsazené noci vlastních rezervací. PRIMARY KEY na noci = databázové UNIQUE omezení:
-- dvě rezervace nemohou obsadit stejnou noc ani při souběžném zápisu.
CREATE TABLE reserved_nights (
  night          TEXT PRIMARY KEY CHECK (night GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  reservation_id TEXT NOT NULL REFERENCES reservations (id) ON DELETE CASCADE
);
CREATE INDEX reserved_nights_reservation ON reserved_nights (reservation_id);
