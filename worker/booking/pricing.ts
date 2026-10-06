// Jediný výpočet ceny pobytu. Používá ho POST /api/quote i POST /api/reservations.
//
// 1. noci pobytu [příjezd, odjezd)
// 2. cena každé noci: daily_prices, jinak výchozí PRICE_PER_NIGHT
// 3. subtotal = součet cen nocí
// 4. sleva: pravidlo z length_discounts s nejvyšším min_nights <= počet nocí
// 5. amountCzk = floor(subtotal × procenta / 100) – sleva se zaokrouhluje DOLŮ na celé Kč
// 6. totalCzk = subtotal − amountCzk
// Vše v celých Kč (celočíselná aritmetika, žádná desetinná čísla).

import { addDays, isIsoDate, type IsoDate } from '../../lib/availability/dates.ts';
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
}

export interface Quote {
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  nights: number;
  subtotalCzk: number;
  discount: { type: 'length'; minNights: number; percent: number; amountCzk: number } | null;
  totalCzk: number;
  nightlyPrices: { date: IsoDate; priceCzk: number }[];
}

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
    subtotalCzk,
    discount,
    totalCzk: subtotalCzk - (discount?.amountCzk ?? 0),
    nightlyPrices,
  };
}

/**
 * Načte ceny nocí pobytu a slevy z D1 a ověří je (fail-closed: neplatný řádek = chyba,
 * nikdy tichý fallback na výchozí cenu).
 * @throws PricingDataError, nebo chyba D1
 */
export async function loadPricingData(db: D1Database, stay: { arrival: IsoDate; departure: IsoDate }): Promise<PricingData> {
  const [prices, discounts] = await db.batch<Record<string, unknown>>([
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
  return { defaultNightlyPriceCzk: PRICE_PER_NIGHT, dailyPrices, discounts: rules };
}

/** Autoritativní cena pobytu ze serverových dat. */
export async function quoteStay(db: D1Database, stay: { arrival: IsoDate; departure: IsoDate }): Promise<Quote> {
  return computeQuote(stay, await loadPricingData(db, stay));
}
