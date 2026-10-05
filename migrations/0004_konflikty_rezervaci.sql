-- Kolize vlastních rezervací s cizími rezervacemi z exportu e-chalup (Airbnb, Booking.com,
-- ruční), které vznikly během zpoždění synchronizace. Jen evidence pro ruční řešení:
-- nic se automaticky neruší. Bez osobních údajů a bez textu cizích událostí.
--
-- - external_fingerprint: SHA-256 z UID cizí události, bez UID z kolidujících nocí.
-- - conflict_start/conflict_end: kolidující noci [start, end).
-- - resolved_at: NULL = kolize trvá. Vyřešená kolize zůstává v historii.
-- - notified_at: NULL = upozornění správci ještě nebylo odesláno (budoucí e-mail).
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

-- Nejvýš jedna aktivní kolize na dvojici rezervace × cizí událost, i při souběžných bězích.
CREATE UNIQUE INDEX reservation_conflicts_active ON reservation_conflicts (reservation_id, external_fingerprint) WHERE resolved_at IS NULL;
