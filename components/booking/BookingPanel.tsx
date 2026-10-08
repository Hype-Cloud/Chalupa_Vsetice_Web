import { ArrowUpRight } from 'lucide-react';
import type { IsoDate } from '../../lib/availability/dates.ts';
import type { Stay } from '../../lib/availability/stay.ts';
import { useI18n } from '../i18n.ts';
import { CAPACITY, INQUIRY_URL } from './config.ts';
import type { QuoteView } from './quoteView.ts';

interface Props {
  today: IsoDate | null;
  stay: Stay;
  guests: number;
  /** Počet nocí vybraného termínu (0 = neúplný výběr). */
  nights: number;
  /** Cena ze serveru (/api/quote) připravená k zobrazení. */
  quote: QuoteView;
  message: string | null;
  onArrival: (date: IsoDate | null) => void;
  onDeparture: (date: IsoDate | null) => void;
  onGuests: (guests: number) => void;
  onRetry: () => void;
}

/** Zelený panel: data pobytu (synchronizovaná s kalendářem), počet hostů a cena ze serveru. */
export function BookingPanel({ today, stay, guests, nights, quote, message, onArrival, onDeparture, onGuests, onRetry }: Props) {
  const { t, plural, formatDate } = useI18n();
  const complete = nights > 0;
  const status = message ?? (quote.kind === 'error' ? quote.message : complete ? null : stay.arrival ? t('booking.panel.selectDeparture') : t('booking.panel.selectStay'));

  return (
    <aside className="booking" aria-labelledby="booking-title" aria-busy={quote.kind === 'loading'}>
      <p className="eyebrow" id="booking-title">{t('booking.panel.eyebrow')}</p>
      {/* Jen cena ze serveru – během načítání ani bez nabídky se žádná částka nezobrazuje. */}
      {quote.kind === 'ready' ? (
        <div className="price" aria-live="polite">{quote.total} <span>{quote.forStay}</span></div>
      ) : (
        <div className={`price is-placeholder${quote.kind === 'loading' ? ' is-loading' : ''}`} aria-live="polite">
          {quote.kind === 'loading' ? quote.label : t('booking.panel.priceHint')}
        </div>
      )}
      <p>{t('booking.panel.capacity', { capacity: CAPACITY })}</p>
      <div className="date-fields">
        <label>
          {t('booking.panel.arrival')}
          <input type="date" min={today ?? undefined} value={stay.arrival ?? ''} onChange={(e) => onArrival(e.target.value || null)} />
        </label>
        <label>
          {t('booking.panel.departure')}
          <input type="date" min={stay.arrival ?? today ?? undefined} value={stay.departure ?? ''} onChange={(e) => onDeparture(e.target.value || null)} />
        </label>
      </div>
      <label className="guests-field">
        {t('booking.panel.guests')}
        <select value={guests} onChange={(e) => onGuests(Number(e.target.value))}>
          {Array.from({ length: CAPACITY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{plural('booking.guests', n)}</option>)}
        </select>
      </label>
      <p className={`result${message || quote.kind === 'error' ? ' is-error' : ''}`} aria-live="polite">
        {status}
        {!message && quote.kind === 'error' && quote.retryable && (
          <> <button type="button" className="link-button" onClick={onRetry}>{quote.retryLabel}</button></>
        )}
      </p>
      {complete && (
        <dl className="estimate">
          <div><dt>{t('booking.summary.arrival')}</dt><dd>{formatDate(stay.arrival!)}</dd></div>
          <div><dt>{t('booking.summary.departure')}</dt><dd>{formatDate(stay.departure!)}</dd></div>
          <div><dt>{t('booking.summary.guests')}</dt><dd>{plural('booking.guests', guests)}</dd></div>
          <div><dt>{t('booking.summary.nights')}</dt><dd>{plural('booking.nights', nights)}</dd></div>
          {quote.kind === 'ready' && quote.discount && (
            <>
              <div><dt>{quote.discount.subtotalLabel}</dt><dd>{quote.discount.subtotal}</dd></div>
              <div><dt>{quote.discount.label}</dt><dd>{quote.discount.amount}</dd></div>
            </>
          )}
          {quote.kind === 'ready' && quote.exactStay && (
            <div className="quote-note"><dt>{quote.exactStay.label}</dt><dd>{quote.exactStay.hint}</dd></div>
          )}
        </dl>
      )}
      <a className="button" href={INQUIRY_URL} target="_blank" rel="noreferrer">{t('booking.panel.inquiry')} <ArrowUpRight size={18} /></a>
      <p className="small">{t('booking.panel.disclaimer')}</p>
    </aside>
  );
}
