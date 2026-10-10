-- Veřejný kód rezervace DDMMYYNN (zároveň variabilní symbol) a splatnost platby.
-- Jen aditivní změny: starší kód (náhodný kód CV-…, VS z čítače sequences) funguje beze změny.

-- Denní čítač pořadí NN v kódu. day = kalendářní den v Europe/Prague (YYYY-MM-DD).
-- Přiděluje se UPSERTem ve stejném D1 batchi jako rezervace (atomicky, bez COUNT(*) + 1);
-- při neúspěchu batche se vrátí i čítač. Překročení 99 poruší CHECK → batch selže (fail closed).
CREATE TABLE reservation_code_counters (
  day  TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  last INTEGER NOT NULL CONSTRAINT reservation_code_limit CHECK (last BETWEEN 1 AND 99)
);

-- Splatnost platby (ISO 8601, UTC) = konec pražského dne, ve kterém uplyne 24 h od created_at
-- (lib/booking/payment.ts → paymentDueAt). U starších rezervací NULL.
-- Zatím se podle ní nic automaticky neruší ani neuvolňuje.
ALTER TABLE reservations ADD COLUMN payment_due_at TEXT CHECK (payment_due_at IS NULL OR (typeof(payment_due_at) = 'text' AND payment_due_at > created_at));
