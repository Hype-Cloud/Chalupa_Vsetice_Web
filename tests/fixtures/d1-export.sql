PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_rezervace.sql','2026-11-22 21:17:22');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_zruseni_uvolni_noci.sql','2026-11-22 21:17:22');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0003_zruseni_sequence.sql','2026-11-22 21:17:22');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0004_konflikty_rezervaci.sql','2026-11-22 21:17:22');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(5,'0005_ceny.sql','2026-11-22 21:17:23');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(6,'0006_ceny_pobytu.sql','2026-11-22 21:17:23');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(7,'0007_poznamka_hosta.sql','2026-11-22 21:17:23');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(8,'0008_kod_rezervace_platba.sql','2026-11-22 21:17:23');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(9,'0009_jazyk_rezervace.sql','2026-11-22 21:17:24');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(10,'0010_kalendar_pobytu.sql','2026-11-22 21:17:24');
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO "meta" ("key","value") VALUES('environment','production');
CREATE TABLE sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO "sequences" ("name","value") VALUES('variable_symbol',0);
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
, note TEXT CHECK (note IS NULL OR (typeof(note) = 'text' AND length(note) BETWEEN 1 AND 2000)), payment_due_at TEXT CHECK (payment_due_at IS NULL OR (typeof(payment_due_at) = 'text' AND payment_due_at > created_at)), locale TEXT CHECK (locale IS NULL OR locale IN ('cs', 'en', 'de', 'ua')), calendar_token TEXT CHECK (calendar_token IS NULL OR (typeof(calendar_token) = 'text' AND length(calendar_token) = 43 AND calendar_token NOT GLOB '*[^A-Za-z0-9_-]*')));
INSERT INTO "reservations" ("id","public_code","arrival","departure","guests","first_name","last_name","phone","email","price_czk","variable_symbol","status","ical_uid","ical_sequence","idempotency_key","request_hash","created_at","updated_at","note","payment_due_at","locale","calendar_token") VALUES('00000000-0000-4000-8000-000000000001','10013001','2030-02-01','2030-02-04',2,'Jan','Zálohový','+420 000 000 000','host-zaloha@example.invalid',8970,'10013001','pending_payment','rez-00000000-0000-4000-8000-000000000001@chalupavsetice.cz',0,NULL,NULL,'2030-01-10T10:00:00.000Z','2030-01-10T10:00:00.000Z','Poznámka; se středníkem a apostrofem '' uvnitř','2030-01-11T22:59:59.000Z','cs','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
INSERT INTO "reservations" ("id","public_code","arrival","departure","guests","first_name","last_name","phone","email","price_czk","variable_symbol","status","ical_uid","ical_sequence","idempotency_key","request_hash","created_at","updated_at","note","payment_due_at","locale","calendar_token") VALUES('00000000-0000-4000-8000-000000000002','10013002','2030-03-01','2030-03-03',4,'Eva','Testovací','+420 000 000 001','host-zaloha-2@example.invalid',5980,'10013002','paid','rez-00000000-0000-4000-8000-000000000002@chalupavsetice.cz',0,NULL,NULL,'2030-01-10T11:00:00.000Z','2030-01-12T08:00:00.000Z',NULL,'2030-01-11T22:59:59.000Z','en',NULL);
CREATE TABLE reserved_nights (
  night          TEXT PRIMARY KEY CHECK (night GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  reservation_id TEXT NOT NULL REFERENCES reservations (id) ON DELETE CASCADE
);
CREATE TABLE reservation_conflicts (
  id                   INTEGER PRIMARY KEY,
  reservation_id       TEXT NOT NULL REFERENCES reservations (id) ON DELETE CASCADE,
  external_fingerprint TEXT NOT NULL,
  conflict_start       TEXT NOT NULL,
  conflict_end         TEXT NOT NULL CHECK (conflict_end > conflict_start),
  detected_at          TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  resolved_at          TEXT,
  notified_at          TEXT
);
CREATE TABLE daily_prices (
  date      TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  price_czk INTEGER NOT NULL CHECK (typeof(price_czk) = 'integer' AND price_czk > 0 AND price_czk <= 1000000)
);
CREATE TABLE length_discounts (
  id               INTEGER PRIMARY KEY,
  min_nights       INTEGER NOT NULL UNIQUE CHECK (typeof(min_nights) = 'integer' AND min_nights >= 1),
  discount_percent INTEGER NOT NULL CHECK (typeof(discount_percent) = 'integer' AND discount_percent BETWEEN 0 AND 100)
);
CREATE TABLE stay_prices (
  arrival_date   TEXT NOT NULL CHECK (arrival_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(arrival_date) IS arrival_date),
  departure_date TEXT NOT NULL CHECK (departure_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(departure_date) IS departure_date),
  total_czk      INTEGER NOT NULL CHECK (typeof(total_czk) = 'integer' AND total_czk > 0 AND total_czk <= 30000000),
  PRIMARY KEY (arrival_date, departure_date),
  CHECK (departure_date > arrival_date)
);
CREATE TABLE reservation_code_counters (
  day  TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  last INTEGER NOT NULL CONSTRAINT reservation_code_limit CHECK (last BETWEEN 1 AND 99)
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',10);
CREATE INDEX reserved_nights_reservation ON reserved_nights (reservation_id);
CREATE UNIQUE INDEX reservation_conflicts_active ON reservation_conflicts (reservation_id, external_fingerprint) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX reservations_calendar_token ON reservations (calendar_token) WHERE calendar_token IS NOT NULL;
CREATE TRIGGER reservations_cancel_release_nights AFTER UPDATE OF status ON reservations WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' BEGIN DELETE FROM reserved_nights WHERE reservation_id = NEW.id; END;
CREATE TRIGGER reservations_cancel_is_final BEFORE UPDATE OF status ON reservations WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancelled reservation cannot be reactivated'); END;
CREATE TRIGGER reservations_cancel_bump_sequence AFTER UPDATE OF status ON reservations WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND (NEW.ical_sequence = OLD.ical_sequence OR NEW.updated_at = OLD.updated_at) BEGIN UPDATE reservations SET ical_sequence = CASE WHEN NEW.ical_sequence = OLD.ical_sequence THEN ical_sequence + 1 ELSE ical_sequence END, updated_at = CASE WHEN NEW.updated_at = OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE updated_at END WHERE id = NEW.id; END;