// Přístup k rezervacím v Cloudflare D1.
//
// Transakce v D1: SQL příkazy BEGIN / COMMIT / SAVEPOINT D1 odmítá a interaktivní transakci
// (čtení → rozhodnutí v kódu → zápis) nelze držet přes více volání. Atomický je jen
// `db.batch([...])`: příkazy běží postupně v jedné transakci a při chybě kteréhokoli z nich se
// vrátí celý batch. Proto se kolize termínů neověřuje dotazem před zápisem, ale databázovým
// omezením (PRIMARY KEY na reserved_nights.night) uvnitř batche, který zároveň založí
// rezervaci a přidělí veřejný kód DDMMYYNN (zároveň variabilní symbol).

import { addDays, type IsoDate } from '../../lib/availability/dates.ts';
import { mergeIntervals } from '../../lib/availability/occupancy.ts';
import type { BusyInterval } from '../../lib/availability/types.ts';
import { paymentDueAt, reservationCodeDay, reservationCodePrefix } from '../../lib/booking/payment.ts';

export type ReservationStatus = 'pending_payment' | 'paid' | 'cancelled';

export interface NewReservation {
  id: string;
  icalUid: string;
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  /** Volitelná poznámka hosta (už validovaná a normalizovaná). Nikdy ne do ReservationSummary. */
  note?: string | null;
  priceCzk: number;
  idempotencyKey: string | null;
  requestHash: string | null;
  /** Čas vytvoření (ISO 8601, UTC). Určuje pražský den v kódu rezervace i splatnost. */
  createdAt: string;
}

/** Veřejně bezpečný souhrn rezervace (bez interního ID, jména, kontaktů a poznámky). */
export interface ReservationSummary {
  /** Veřejný kód DDMMYYNN (u rezervací před migrací 0008 starší formát CV-…). */
  code: string;
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  priceCzk: number;
  /** U nových rezervací shodný s `code`. */
  variableSymbol: string;
  status: ReservationStatus;
  /** Splatnost platby (ISO 8601, UTC). */
  paymentDueAt: string;
}

/** Některá z nocí už patří jiné rezervaci. */
export class NightsTakenError extends Error {
  constructor() {
    super('nights-taken');
    this.name = 'NightsTakenError';
  }
}

/** V daném pražském dni už bylo přiděleno všech 99 kódů rezervace – nová se nezaloží. */
export class ReservationCodesExhaustedError extends Error {
  constructor() {
    super('reservation-codes-exhausted');
    this.name = 'ReservationCodesExhaustedError';
  }
}

/** Porušení UNIQUE u jiného sloupce (kolize ID, souběžný požadavek se stejným klíčem). */
export class DuplicateError extends Error {
  readonly column: 'public_code' | 'idempotency_key' | 'ical_uid' | 'id' | 'variable_symbol';
  constructor(column: DuplicateError['column']) {
    super(`duplicate-${column}`);
    this.name = 'DuplicateError';
    this.column = column;
  }
}

/** Noci pobytu [arrival, departure). */
export function nightsOf(arrival: IsoDate, departure: IsoDate): IsoDate[] {
  const nights: IsoDate[] = [];
  for (let night = arrival; night < departure; night = addDays(night, 1)) nights.push(night);
  return nights;
}

function translateError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('CHECK constraint failed') && message.includes('reservation_code_limit')) return new ReservationCodesExhaustedError();
  if (!message.includes('UNIQUE constraint failed')) return error;
  if (message.includes('reserved_nights.night')) return new NightsTakenError();
  for (const column of ['public_code', 'idempotency_key', 'ical_uid', 'variable_symbol', 'id'] as const) {
    if (message.includes(`reservations.${column}`)) return new DuplicateError(column);
  }
  return error;
}

/**
 * Atomicky založí rezervaci v jednom D1 batchi:
 * 1. UPSERT denního čítače (pražský den z createdAt) – další NN, nikdy COUNT(*) + 1,
 * 2. INSERT rezervace s kódem DDMMYYNN z čítače (public_code i variable_symbol) a splatností,
 * 3. obsazení všech nocí.
 * Selže-li cokoli (obsazená noc, 100. rezervace dne → CHECK reservation_code_limit), D1 vrátí
 * celý batch: žádná rezervace, žádné noci, čítač beze změny. Souběžné batche D1 provádí
 * postupně, takže dvě rezervace nikdy nedostanou stejné NN (pojistkou je i UNIQUE public_code).
 * @throws NightsTakenError, ReservationCodesExhaustedError, DuplicateError, jinak chyba databáze
 */
export async function insertReservation(db: D1Database, r: NewReservation): Promise<ReservationSummary> {
  const nights = nightsOf(r.arrival, r.departure);
  const day = reservationCodeDay(new Date(r.createdAt));
  const dueAt = paymentDueAt(r.createdAt);
  const code = `(SELECT ?16 || printf('%02d', last) FROM reservation_code_counters WHERE day = ?17)`;
  const statements = [
    db.prepare(`INSERT INTO reservation_code_counters (day, last) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET last = last + 1`).bind(day),
    db
      .prepare(
        `INSERT INTO reservations (id, public_code, arrival, departure, guests, first_name, last_name, phone, email, price_czk,
           variable_symbol, status, ical_uid, idempotency_key, request_hash, created_at, updated_at, note, payment_due_at)
         VALUES (?1, ${code}, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
           ${code}, 'pending_payment', ?10, ?11, ?12, ?13, ?13, ?14, ?15)`,
      )
      .bind(r.id, r.arrival, r.departure, r.guests, r.firstName, r.lastName, r.phone, r.email, r.priceCzk, r.icalUid, r.idempotencyKey, r.requestHash, r.createdAt, r.note ?? null, dueAt, reservationCodePrefix(day), day),
    // Jeden řádek na noc; PRIMARY KEY (night) odmítne noc, kterou už má jiná rezervace.
    ...nights.map((night) => db.prepare('INSERT INTO reserved_nights (night, reservation_id) VALUES (?1, ?2)').bind(night, r.id)),
    db.prepare(`SELECT public_code, variable_symbol FROM reservations WHERE id = ?1`).bind(r.id),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw translateError(error);
  }
  const row = results[results.length - 1].results[0] as { public_code: string; variable_symbol: string } | undefined;
  if (!row) throw new Error('reservation-not-readable');
  return { code: row.public_code, arrival: r.arrival, departure: r.departure, guests: r.guests, priceCzk: r.priceCzk, variableSymbol: row.variable_symbol, status: 'pending_payment', paymentDueAt: dueAt };
}

export async function findByIdempotencyKey(db: D1Database, key: string): Promise<(ReservationSummary & { requestHash: string | null }) | null> {
  const row = await db
    .prepare(
      `SELECT public_code, arrival, departure, guests, price_czk, variable_symbol, status, request_hash, created_at, payment_due_at
       FROM reservations WHERE idempotency_key = ?1`,
    )
    .bind(key)
    .first<{ public_code: string; arrival: string; departure: string; guests: number; price_czk: number; variable_symbol: string; status: ReservationStatus; request_hash: string | null; created_at: string; payment_due_at: string | null }>();
  if (!row) return null;
  return {
    code: row.public_code,
    arrival: row.arrival,
    departure: row.departure,
    guests: row.guests,
    priceCzk: row.price_czk,
    variableSymbol: row.variable_symbol,
    status: row.status,
    // Rezervace z doby před migrací 0008 splatnost uloženou nemají – stejné pravidlo z created_at.
    paymentDueAt: row.payment_due_at ?? paymentDueAt(row.created_at),
    requestHash: row.request_hash,
  };
}

/** Obsazené noci aktivních (nezrušených) vlastních rezervací v rozsahu [from, to) jako intervaly. */
export async function listReservedNights(db: D1Database, range: { from: IsoDate; to: IsoDate }): Promise<BusyInterval[]> {
  const { results } = await db
    .prepare(
      `SELECT n.night FROM reserved_nights n JOIN reservations r ON r.id = n.reservation_id
       WHERE n.night >= ?1 AND n.night < ?2 AND r.status <> 'cancelled' ORDER BY n.night`,
    )
    .bind(range.from, range.to)
    .all<{ night: string }>();
  return mergeIntervals(results.map(({ night }) => ({ start: night, end: addDays(night, 1) })));
}

/** Označení databáze (production / preview) z tabulky meta, nebo null. */
export async function databaseEnvironment(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = 'environment'`).first<{ value: string }>();
  return row?.value ?? null;
}


/**
 * Rezervace pro výstupní iCal včetně kontaktů (jen pro autorizovaný export). Zrušené rezervace
 * se exportují jako zrušené události (STATUS:CANCELLED), osobní údaje se u nich nepoužijí.
 */
export interface ExportReservation {
  code: string;
  icalUid: string;
  icalSequence: number;
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  /** Poznámka hosta (prostý text, při výstupu escapovat podle formátu), jinak null. */
  note: string | null;
  priceCzk: number;
  variableSymbol: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
}

export async function listExportReservations(db: D1Database): Promise<ExportReservation[]> {
  const { results } = await db
    .prepare(
      `SELECT public_code AS code, ical_uid AS icalUid, ical_sequence AS icalSequence, arrival, departure, guests,
         first_name AS firstName, last_name AS lastName, phone, email, note, price_czk AS priceCzk,
         variable_symbol AS variableSymbol, status, created_at AS createdAt, updated_at AS updatedAt
       FROM reservations ORDER BY arrival, ical_uid`,
    )
    .all<ExportReservation>();
  return results;
}

/**
 * Zruší rezervaci (podle interního ID) a uvolní její noci. Oboje proběhne atomicky: noci maže
 * trigger `reservations_cancel_release_nights` ve stejné transakci jako změnu stavu. Řádek
 * rezervace zůstává kvůli historii; SEQUENCE se zvýší kvůli iCal exportu.
 * @returns false, pokud rezervace neexistuje nebo už je zrušená (opakované zrušení nic nemění)
 */
export async function cancelReservation(db: D1Database, id: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE reservations SET status = 'cancelled', ical_sequence = ical_sequence + 1, updated_at = ?2
       WHERE id = ?1 AND status <> 'cancelled'`,
    )
    .bind(id, now)
    .run();
  return result.meta.changes > 0;
}
