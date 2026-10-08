// Přístup k rezervacím v Cloudflare D1.
//
// Transakce v D1: SQL příkazy BEGIN / COMMIT / SAVEPOINT D1 odmítá a interaktivní transakci
// (čtení → rozhodnutí v kódu → zápis) nelze držet přes více volání. Atomický je jen
// `db.batch([...])`: příkazy běží postupně v jedné transakci a při chybě kteréhokoli z nich se
// vrátí celý batch. Proto se kolize termínů neověřuje dotazem před zápisem, ale databázovým
// omezením (PRIMARY KEY na reserved_nights.night) uvnitř batche, který zároveň založí
// rezervaci a přidělí variabilní symbol.

import { addDays, type IsoDate } from '../../lib/availability/dates.ts';
import { mergeIntervals } from '../../lib/availability/occupancy.ts';
import type { BusyInterval } from '../../lib/availability/types.ts';

export type ReservationStatus = 'pending_payment' | 'paid' | 'cancelled';

export interface NewReservation {
  id: string;
  publicCode: string;
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
  /** Prefix variabilního symbolu (dvojčíslí roku založení). */
  vsPrefix: string;
  createdAt: string;
}

/** Veřejně bezpečný souhrn rezervace (bez jména, kontaktů a poznámky). */
export interface ReservationSummary {
  code: string;
  arrival: IsoDate;
  departure: IsoDate;
  guests: number;
  priceCzk: number;
  variableSymbol: string;
  status: ReservationStatus;
}

/** Některá z nocí už patří jiné rezervaci. */
export class NightsTakenError extends Error {
  constructor() {
    super('nights-taken');
    this.name = 'NightsTakenError';
  }
}

/** Porušení UNIQUE u jiného sloupce (kolize náhodného kódu, souběžný požadavek se stejným klíčem). */
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
  if (!message.includes('UNIQUE constraint failed')) return error;
  if (message.includes('reserved_nights.night')) return new NightsTakenError();
  for (const column of ['public_code', 'idempotency_key', 'ical_uid', 'variable_symbol', 'id'] as const) {
    if (message.includes(`reservations.${column}`)) return new DuplicateError(column);
  }
  return error;
}

/**
 * Atomicky založí rezervaci: zvýší čítač VS, vloží rezervaci s VS odvozeným z čítače a obsadí
 * všechny její noci. Pokud je kterákoli noc obsazená, D1 vrátí celý batch (žádná rezervace,
 * žádné noci, čítač beze změny).
 * @throws NightsTakenError, DuplicateError, jinak původní chyba databáze
 */
export async function insertReservation(db: D1Database, r: NewReservation): Promise<ReservationSummary> {
  const nights = nightsOf(r.arrival, r.departure);
  const statements = [
    db.prepare(`UPDATE sequences SET value = value + 1 WHERE name = 'variable_symbol'`),
    db
      .prepare(
        `INSERT INTO reservations (id, public_code, arrival, departure, guests, first_name, last_name, phone, email, price_czk,
           variable_symbol, status, ical_uid, idempotency_key, request_hash, created_at, updated_at, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
           (SELECT printf('%s%06d', ?11, value) FROM sequences WHERE name = 'variable_symbol'),
           'pending_payment', ?12, ?13, ?14, ?15, ?15, ?16)`,
      )
      .bind(r.id, r.publicCode, r.arrival, r.departure, r.guests, r.firstName, r.lastName, r.phone, r.email, r.priceCzk, r.vsPrefix, r.icalUid, r.idempotencyKey, r.requestHash, r.createdAt, r.note ?? null),
    // Jeden řádek na noc; PRIMARY KEY (night) odmítne noc, kterou už má jiná rezervace.
    ...nights.map((night) => db.prepare('INSERT INTO reserved_nights (night, reservation_id) VALUES (?1, ?2)').bind(night, r.id)),
    db.prepare(`SELECT variable_symbol FROM reservations WHERE id = ?1`).bind(r.id),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw translateError(error);
  }
  const row = results[results.length - 1].results[0] as { variable_symbol: string } | undefined;
  if (!row) throw new Error('reservation-not-readable');
  return { code: r.publicCode, arrival: r.arrival, departure: r.departure, guests: r.guests, priceCzk: r.priceCzk, variableSymbol: row.variable_symbol, status: 'pending_payment' };
}

export async function findByIdempotencyKey(db: D1Database, key: string): Promise<(ReservationSummary & { requestHash: string | null }) | null> {
  const row = await db
    .prepare(
      `SELECT public_code, arrival, departure, guests, price_czk, variable_symbol, status, request_hash
       FROM reservations WHERE idempotency_key = ?1`,
    )
    .bind(key)
    .first<{ public_code: string; arrival: string; departure: string; guests: number; price_czk: number; variable_symbol: string; status: ReservationStatus; request_hash: string | null }>();
  if (!row) return null;
  return {
    code: row.public_code,
    arrival: row.arrival,
    departure: row.departure,
    guests: row.guests,
    priceCzk: row.price_czk,
    variableSymbol: row.variable_symbol,
    status: row.status,
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
