// Detekce kolizí vzniklých během zpoždění synchronizace kalendářů.
//
// Rezervace z webu se ověří proti čerstvému exportu e-chalup (POST /api/reservations), ale
// Airbnb nebo Booking.com mohou ve stejné chvíli prodat stejný termín a do exportu e-chalup
// se ta rezervace dostane až později. Takovou kolizi nejde zabránit, jen ji rychle odhalit.
//
// Při každém čerstvém stažení exportu (GET /api/availability) se aktivní vlastní rezervace
// porovnají s cizími událostmi exportu a výsledek se uloží do reservation_conflicts.
// Nic se automaticky neruší – kolizi řeší majitel ručně.

import type { IsoDate } from '../../lib/availability/dates.ts';
import type { CalendarEvent } from '../ical.ts';
import { sha256 } from '../secrets.ts';
import { databaseEnvironment } from './db.ts';
import { isOwnEcho } from './external.ts';

/** Události z jednoho čerstvého stažení exportu e-chalup. */
export interface ExternalSnapshot {
  events: readonly CalendarEvent[];
  /** Rozsah, na který jsou události oříznuté. */
  range: { from: IsoDate; to: IsoDate };
  /**
   * true = export se převedl celý (žádná vynechaná událost). Jen úplný snapshot smí kolizi
   * označit za vyřešenou; z neúplného se kolize jen přidávají.
   */
  complete: boolean;
}

/** Nově zjištěná kolize (bez osobních údajů) – podklad pro budoucí upozornění. */
export interface NewConflict {
  reservationCode: string;
  start: IsoDate;
  end: IsoDate;
}

export interface ReconcileResult {
  newConflicts: NewConflict[];
  /** Počet trvajících (nevyřešených) kolizí po tomto běhu. */
  active: number;
}

interface OwnReservation {
  id: string;
  code: string;
  icalUid: string;
  arrival: IsoDate;
  departure: IsoDate;
  status: string;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Otisk cizí události: podle UID (u výskytu opakované události UID + RECURRENCE-ID, protože
 * výskyty sdílejí UID), bez UID podle kolidujících nocí (průnik s rezervací, ne oříznutý
 * interval události – ten se s posunem rozsahu mění). Hash, aby se v D1 neukládala cizí UID.
 */
export async function conflictFingerprint(event: CalendarEvent, nights: { start: IsoDate; end: IsoDate }): Promise<string> {
  const identity = !event.uid
    ? `nights:${nights.start}/${nights.end}`
    : event.recurrenceId
      ? `uid:${event.uid}|recurrence:${event.recurrenceId}`
      : `uid:${event.uid}`;
  return hex(await sha256(identity));
}

/**
 * Porovná vlastní rezervace s cizími událostmi a srovná stav reservation_conflicts.
 *
 * - Vyhodnocují se nezrušené rezervace celé ležící v rozsahu snapshotu (dřív začaté nebo
 *   přesahující horizont se nechávají beze změny – jejich noci snapshot nepokrývá celé).
 * - Ozvěna jakékoli vlastní rezervace (stejné UID nebo kód) se za cizí událost nepovažuje.
 * - Kolize = společná noc; navazující pobyty (odjezd = příjezd) kolizí nejsou.
 * - Vše proběhne v jednom D1 batchi (atomicky); částečný UNIQUE index brání duplicitám
 *   i při souběžných bězích.
 */
export async function reconcileConflicts(db: D1Database, snapshot: ExternalSnapshot, now: Date): Promise<ReconcileResult> {
  const { range } = snapshot;
  const { results: own } = await db
    .prepare(
      `SELECT id, public_code AS code, ical_uid AS icalUid, arrival, departure, status
       FROM reservations WHERE departure > ?1 AND arrival < ?2 ORDER BY arrival, id`,
    )
    .bind(range.from, range.to)
    .all<OwnReservation>();

  const foreign = snapshot.events.filter((event) => !own.some((r) => isOwnEcho(event, { icalUid: r.icalUid, code: r.code })));
  const checked = own.filter((r) => r.status !== 'cancelled' && r.arrival >= range.from && r.departure <= range.to);

  // Požadovaný stav: jedna kolize na dvojici rezervace × otisk cizí události.
  const desired = new Map<string, { reservation: OwnReservation; fingerprint: string; start: IsoDate; end: IsoDate }>();
  for (const reservation of checked) {
    for (const event of foreign) {
      const start = event.start > reservation.arrival ? event.start : reservation.arrival;
      const end = event.end < reservation.departure ? event.end : reservation.departure;
      if (start >= end) continue;
      const fingerprint = await conflictFingerprint(event, { start, end });
      const key = `${reservation.id}|${fingerprint}`;
      const existing = desired.get(key);
      // Stejný otisk = stejná událost (např. duplicitní VEVENT) → jeden záznam.
      if (existing) {
        if (start < existing.start) existing.start = start;
        if (end > existing.end) existing.end = end;
      } else {
        desired.set(key, { reservation, fingerprint, start, end });
      }
    }
  }

  const stamp = now.toISOString();
  // Deterministické pořadí (stejný snapshot = stejné příkazy).
  const ordered = [...desired.values()].sort((a, b) => (a.reservation.id + a.fingerprint < b.reservation.id + b.fingerprint ? -1 : 1));
  const upserts = ordered.map((c) =>
    db
      .prepare(
        `INSERT INTO reservation_conflicts (reservation_id, external_fingerprint, conflict_start, conflict_end, detected_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (reservation_id, external_fingerprint) WHERE resolved_at IS NULL
         DO UPDATE SET last_seen_at = excluded.last_seen_at, conflict_start = excluded.conflict_start, conflict_end = excluded.conflict_end
         RETURNING detected_at`,
      )
      .bind(c.reservation.id, c.fingerprint, c.start, c.end, stamp),
  );

  const statements = [
    ...upserts,
    // Zrušená vlastní rezervace nemá aktivní kolizi (nezávisí na datech z e-chalup).
    db
      .prepare(
        `UPDATE reservation_conflicts SET resolved_at = ?1
         WHERE resolved_at IS NULL AND reservation_id IN (SELECT id FROM reservations WHERE status = 'cancelled')`,
      )
      .bind(stamp),
  ];
  if (snapshot.complete) {
    // Jen úplný snapshot smí kolizi uzavřít. last_seen_at < now: kolizi obnovenou souběžným
    // novějším během starší běh neuzavře.
    statements.push(
      db
        .prepare(
          `UPDATE reservation_conflicts SET resolved_at = ?1
           WHERE resolved_at IS NULL AND last_seen_at < ?1 AND reservation_id IN (
             SELECT id FROM reservations WHERE status <> 'cancelled' AND arrival >= ?2 AND departure <= ?3)`,
        )
        .bind(stamp, range.from, range.to),
    );
  }
  statements.push(db.prepare(`SELECT count(*) AS active FROM reservation_conflicts WHERE resolved_at IS NULL`));

  const results = await db.batch(statements);
  const newConflicts = ordered
    .filter((_, i) => (results[i].results[0] as { detected_at: string } | undefined)?.detected_at === stamp)
    .map((c) => ({ reservationCode: c.reservation.code, start: c.start, end: c.end }));
  const active = (results[results.length - 1].results[0] as { active: number }).active;
  return { newConflicts, active };
}

/**
 * Trvající kolize, o kterých správce ještě nedostal upozornění (notified_at IS NULL).
 * Budoucí odesílání e-mailů je zpracuje a označí přes markConflictsNotified.
 */
export async function pendingConflictNotifications(db: D1Database): Promise<{ id: number; reservationCode: string; start: IsoDate; end: IsoDate; detectedAt: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, r.public_code AS reservationCode, c.conflict_start AS start, c.conflict_end AS end, c.detected_at AS detectedAt
       FROM reservation_conflicts c JOIN reservations r ON r.id = c.reservation_id
       WHERE c.resolved_at IS NULL AND c.notified_at IS NULL ORDER BY c.detected_at, c.id`,
    )
    .all<{ id: number; reservationCode: string; start: string; end: string; detectedAt: string }>();
  return results;
}

/** Označí upozornění jako odeslaná; znovu se pro tutéž kolizi nepožadují. */
export async function markConflictsNotified(db: D1Database, ids: readonly number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(ids.map((id) => db.prepare(`UPDATE reservation_conflicts SET notified_at = ?2 WHERE id = ?1 AND notified_at IS NULL`).bind(id, now.toISOString())));
}

/**
 * Vstup z Workeru: ověří prostředí databáze a spustí reconciliation. Loguje jen počty,
 * nikdy jména, kontakty, texty událostí ani adresu exportu.
 */
export async function runConflictReconciliation(
  env: { DB?: D1Database; BOOKING_ENV?: string },
  snapshot: ExternalSnapshot,
  now: Date,
  log: (message: string) => void,
): Promise<ReconcileResult | null> {
  if (!env.DB || !env.BOOKING_ENV) return null;
  try {
    if ((await databaseEnvironment(env.DB)) !== env.BOOKING_ENV) {
      log('conflicts: database environment mismatch');
      return null;
    }
    const result = await reconcileConflicts(env.DB, snapshot, now);
    if (result.newConflicts.length > 0 || result.active > 0) {
      log(`conflicts: ${result.newConflicts.length} new, ${result.active} active`);
    }
    return result;
  } catch {
    log('conflicts: reconciliation failed');
    return null;
  }
}
