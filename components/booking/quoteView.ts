// Co panel zobrazí pro stav cenové nabídky. Jen formátuje hodnoty ze serveru – žádný výpočet ceny.

import type { I18n } from '../../lib/i18n/index.ts';
import { CAPACITY, MAX_NIGHTS, MIN_NIGHTS } from '../../lib/booking/rules.ts';
import type { QuoteError, QuoteState } from './quote.ts';

export type QuoteView =
  | { kind: 'idle' }
  | { kind: 'loading'; label: string }
  | {
      kind: 'ready';
      /** Celková cena ze serveru (totalCzk). */
      total: string;
      /** „za 3 noci“ */
      forStay: string;
      /** Pevná cena celého pobytu (pricingMode exact-stay). */
      exactStay: { label: string; hint: string } | null;
      /** Rozpis slevy (pricingMode nightly s množstevní slevou). */
      discount: { subtotalLabel: string; subtotal: string; label: string; amount: string } | null;
    }
  | { kind: 'error'; message: string; retryable: boolean; retryLabel: string };

/** Uživatelská hláška k chybě nabídky; technické kódy serveru se nezobrazují. */
export function quoteErrorMessage(error: QuoteError, i18n: I18n): { message: string; retryable: boolean } {
  if (error.kind === 'invalid') {
    if (error.fields.includes('arrivalDate')) return { message: i18n.t('booking.quote.error.arrivalDate'), retryable: false };
    if (error.fields.includes('departureDate')) return { message: i18n.t('booking.quote.error.departureDate', { min: MIN_NIGHTS, max: MAX_NIGHTS }), retryable: false };
    if (error.fields.includes('guests')) return { message: i18n.t('booking.quote.error.guests', { capacity: CAPACITY }), retryable: false };
    return { message: i18n.t('booking.quote.error.invalid'), retryable: false };
  }
  if (error.kind === 'network') return { message: i18n.t('booking.quote.error.network'), retryable: true };
  return { message: i18n.t('booking.quote.error.unavailable'), retryable: true };
}

export function quoteView(state: QuoteState, i18n: I18n): QuoteView {
  switch (state.status) {
    case 'idle':
      return { kind: 'idle' };
    case 'loading':
      return { kind: 'loading', label: i18n.t('booking.quote.loading') };
    case 'error':
      return { kind: 'error', ...quoteErrorMessage(state.error, i18n), retryLabel: i18n.t('booking.quote.retry') };
    case 'ready': {
      const { quote } = state;
      const exact = quote.pricingMode === 'exact-stay';
      return {
        kind: 'ready',
        total: i18n.formatPrice(quote.totalCzk),
        forStay: i18n.t('booking.quote.forStay', { nights: i18n.plural('booking.nights', quote.nights) }),
        exactStay: exact ? { label: i18n.t('booking.quote.exactStay'), hint: i18n.t('booking.quote.exactStayHint') } : null,
        discount:
          !exact && quote.discount && quote.discount.amountCzk > 0
            ? {
                subtotalLabel: i18n.t('booking.quote.subtotal'),
                subtotal: i18n.formatPrice(quote.subtotalCzk),
                label: i18n.t('booking.quote.discount', { percent: quote.discount.percent, minNights: i18n.plural('booking.nights', quote.discount.minNights) }),
                amount: `−${i18n.formatPrice(quote.discount.amountCzk)}`,
              }
            : null,
      };
    }
  }
}
