-- Zrušení rezervace musí vždy zvýšit SEQUENCE (a čas změny), jinak e-chalupy STATUS:CANCELLED
-- ve výstupním iCalu nepřevezmou. cancelReservation() obojí nastavuje sama; tento trigger to
-- doplní i při ručním UPDATE stavu (např. wrangler d1 execute). Když UPDATE SEQUENCE nebo
-- updated_at už změnil, trigger je nechá být – nedochází k dvojímu navýšení.
CREATE TRIGGER reservations_cancel_bump_sequence AFTER UPDATE OF status ON reservations WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND (NEW.ical_sequence = OLD.ical_sequence OR NEW.updated_at = OLD.updated_at) BEGIN UPDATE reservations SET ical_sequence = CASE WHEN NEW.ical_sequence = OLD.ical_sequence THEN ical_sequence + 1 ELSE ical_sequence END, updated_at = CASE WHEN NEW.updated_at = OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE updated_at END WHERE id = NEW.id; END;
