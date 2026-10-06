// Jediný výpočet ceny pobytu. Používá ho POST /api/quote i POST /api/reservations.
//
// Priorita pravidel:
// A. stay_prices – pevná celková cena pro přesně tento příjezd + odjezd (pricingMode
//    "exact-stay"). Je autoritativní: daily_prices, výchozí cena ani length_discounts se
//    nepoužijí, sleva je null a rozpis po nocích prázdný (žádný vymyšlený rozpis).
//    Jen cenové pravidlo – dostupnost ani jiné termíny neovlivňuje.
// B. jinak výpočet po nocích (pricingMode "nightly"):
// 1. noci pobytu [příjezd, odjezd)
// 2. cena každé noci: daily_prices, jinak výchozí PRICE_PER_NIGHT
// 3. subtotal = součet cen nocí
// 4. sleva: pravidlo z length_discounts s nejvyšším min_nights <= počet nocí
// 5. amountCzk = floor(subtotal × procenta / 100) – sleva se zaokrouhluje DOLŮ na celé Kč
// 6. totalCzk = subtotal − amountCzk
// Vše v celých Kč (celočíselná aritmetika, žádná desetinná čísla).

import { addDays, diffDays, isIsoDate, type IsoDate } from '../../lib/availability/dates.ts';
import { PRICE_PER_NIGHT } from '../../lib/booking/rules.ts';

export interface LengthDiscount {
  minNights: number;
  percent: number;
}

export interface PricingData {
  defaultNightlyPriceCzk: number;
  /** Ceny jednotlivých nocí (jen dny s vlastní cenou). */
  dailyPrices: ReadonlyMap<IsoDate, number>;
  discounts: readonly LengthDiscount[];
  /** Pevná celková cena přesně tohoto pobytu ze stay_prices, jinak null. */
  stayPriceCzk: number | null;
}

/** Jak byla cena určena; frontend podle toho pozná pevnou cenu celého pobytu. */
export type PricingMode = 'nightly' | 'exact-stay';

export interface Quote {
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  nights: number;
  pricingMode: PricingMode;
  subtotalCzk: number;
  discount: { type: 'length'; minNights: number; percent: number; amountCzk: number } | null;
  totalCzk: number;
  /** Ceny jednotlivých nocí; u pricingMode "exact-stay" prázdné. */
  nightlyPrices: { date: IsoDate; priceCzk: number }[];
}

/** Horní limit pevné ceny pobytu (stejný jako CHECK v migraci 0006). */
const MAX_STAY_PRICE_CZK = 30_000_000;

/** Ceníková data v D1 jsou neplatná – cenu nelze bezpečně spočítat. */
export class PricingDataError extends Error {
  constructor() {
    super('invalid-pricing-data');
    this.name = 'PricingDataError';
  }
}

const isPositiveInt = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;

/** Čistý výpočet (bez databáze). Předpokládá ověřený termín s alespoň jednou nocí. */
export function computeQuote(stay: { arrival: IsoDate; departure: IsoDate }, data: PricingData): Quote {
  if (data.stayPriceCzk !== null) {
    return {
      arrivalDate: stay.arrival,
      departureDate: stay.departure,
      nights: diffDays(stay.arrival, stay.departure),
      pricingMode: 'exact-stay',
      subtotalCzk: data.stayPriceCzk,
      discount: null,
      totalCzk: data.stayPriceCzk,
      nightlyPrices: [],
    };
  }
  const nightlyPrices: Quote['nightlyPrices'] = [];
  for (let date = stay.arrival; date < stay.departure; date = addDays(date, 1)) {
    nightlyPrices.push({ date, priceCzk: data.dailyPrices.get(date) ?? data.defaultNightlyPriceCzk });
  }
  const nights = nightlyPrices.length;
  const subtotalCzk = nightlyPrices.reduce((sum, night) => sum + night.priceCzk, 0);
  const rule = data.discounts.filter((d) => d.minNights <= nights).reduce<LengthDiscount | null>((best, d) => (!best || d.minNights > best.minNights ? d : best), null);
  const discount = rule ? { type: 'length' as const, minNights: rule.minNights, percent: rule.percent, amountCzk: Math.floor((subtotalCzk * rule.percent) / 100) } : null;
  return {
    arrivalDate: stay.arrival,
    departureDate: stay.departure,
    nights,
    pricingMode: 'nightly',
    subtotalCzk,
    discount,
    totalCzk: subtotalCzk - (discount?.amountCzk ?? 0),
    nightlyPrices,
  };
}

/**
 * Načte pevnou cenu pobytu, ceny nocí pobytu a slevy z D1 (jeden batch) a ověří je (fail-closed: neplatný řádek = chyba,
 * nikdy tichý fallback na výchozí cenu).
 * @throws PricingDataError, nebo chyba D1
 */
export async function loadPricingData(db: D1Database, stay: { arrival: IsoDate; departure: IsoDate }): Promise<PricingData> {
  const [stayPrices, prices, discounts] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT arrival_date, departure_date, total_czk FROM stay_prices WHERE arrival_date = ?1 AND departure_date = ?2').bind(stay.arrival, stay.departure),
    db.prepare('SELECT date, price_czk FROM daily_prices WHERE date >= ?1 AND date < ?2').bind(stay.arrival, stay.departure),
    db.prepare('SELECT min_nights, discount_percent FROM length_discounts'),
  ]);
  const dailyPrices = new Map<IsoDate, number>();
  for (const row of prices.results) {
    if (!isIsoDate(row.date) || !isPositiveInt(row.price_czk, 1_000_000)) throw new PricingDataError();
    dailyPrices.set(row.date, row.price_czk);
  }
  const rules: LengthDiscount[] = [];
  for (const row of discounts.results) {
    const percent = row.discount_percent;
    if (!isPositiveInt(row.min_nights, 10_000) || typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) throw new PricingDataError();
    if (rules.some((r) => r.minNights === row.min_nights)) throw new PricingDataError();
    rules.push({ minNights: row.min_nights, percent });
  }
  // Víc řádků pro stejný pár by znamenalo poškozené schéma (chybí PRIMARY KEY).
  if (stayPrices.results.length > 1) throw new PricingDataError();
  let stayPriceCzk: number | null = null;
  for (const row of stayPrices.results) {
    if (row.arrival_date !== stay.arrival || row.departure_date !== stay.departure || !isPositiveInt(row.total_czk, MAX_STAY_PRICE_CZK)) throw new PricingDataError();
    stayPriceCzk = row.total_czk;
  }
  return { defaultNightlyPriceCzk: PRICE_PER_NIGHT, dailyPrices, discounts: rules, stayPriceCzk };
}

/** Autoritativní cena pobytu ze serverových dat. */
export async function quoteStay(db: D1Database, stay: { arrival: IsoDate; departure: IsoDate }): Promise<Quote> {
  return computeQuote(stay, await loadPricingData(db, stay));
}
