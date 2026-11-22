-- Neveřejný token odkazu „přidat do kalendáře“ (GET /calendar/<token>.ics). Capability URL:
-- kdo zná odkaz, stáhne událost pobytu, proto je token oddělený od interního id, veřejného kódu
-- i VS: 32 kryptograficky náhodných bajtů v base64url (43 znaků). Stabilní po celou dobu života
-- rezervace (replay vrací stejnou URL).
-- Jen aditivní změny: starší kód sloupec nevyplňuje (NULL = rezervace bez odkazu do kalendáře).
ALTER TABLE reservations ADD COLUMN calendar_token TEXT CHECK (calendar_token IS NULL OR (typeof(calendar_token) = 'text' AND length(calendar_token) = 43 AND calendar_token NOT GLOB '*[^A-Za-z0-9_-]*'));

-- Lookup podle tokenu a unikátnost (víc rezervací s NULL je v pořádku).
CREATE UNIQUE INDEX reservations_calendar_token ON reservations (calendar_token) WHERE calendar_token IS NOT NULL;
