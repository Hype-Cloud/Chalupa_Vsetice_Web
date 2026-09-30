-- Zrušení rezervace atomicky uvolní její noci. Trigger běží ve stejné transakci jako změna
-- stavu, takže platí i pro ruční UPDATE (např. wrangler d1 execute). Řádek rezervace zůstává
-- (historie), mažou se jen obsazené noci.
CREATE TRIGGER reservations_cancel_release_nights AFTER UPDATE OF status ON reservations WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' BEGIN DELETE FROM reserved_nights WHERE reservation_id = NEW.id; END;

-- Zrušenou rezervaci nelze vrátit do aktivního stavu: její noci už mohou patřit jiné rezervaci.
CREATE TRIGGER reservations_cancel_is_final BEFORE UPDATE OF status ON reservations WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancelled reservation cannot be reactivated'); END;

-- Úklid nocí rezervací zrušených před touto migrací.
DELETE FROM reserved_nights WHERE reservation_id IN (SELECT id FROM reservations WHERE status = 'cancelled');
