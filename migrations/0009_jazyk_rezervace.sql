-- Jazyk webu při rezervaci (cs | en | de | ua) – jazyk potvrzovacího e-mailu a dalších e-mailů
-- k rezervaci. Jen aditivní nullable sloupec: starší kód ho nevyplňuje (NULL), starší rezervace
-- jazyk nemají. Validace: worker/booking/validation.ts; CHECK je pojistka.
ALTER TABLE reservations ADD COLUMN locale TEXT CHECK (locale IS NULL OR locale IN ('cs', 'en', 'de', 'ua'));
