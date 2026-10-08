-- Volitelná poznámka hosta k rezervaci (prostý text, NFC, nejvýš 2000 znaků).
-- Validace a normalizace: worker/booking/validation.ts (validateNote). CHECK je jen pojistka
-- pro případ obejití validace; length() v SQLite počítá znaky (code pointy) stejně jako Worker.
-- Poznámka není ve veřejné odpovědi rezervace ani v logách; jde jen do autorizovaného iCal exportu.
ALTER TABLE reservations ADD COLUMN note TEXT CHECK (note IS NULL OR (typeof(note) = 'text' AND length(note) BETWEEN 1 AND 2000));
