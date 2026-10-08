import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { IsoDate } from '../../lib/availability/dates.ts';
import type { Stay } from '../../lib/availability/stay.ts';
import { useI18n } from '../i18n.ts';
import { CAPACITY, INQUIRY_URL } from './config.ts';
import { DateField } from './DateField.tsx';
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
  /** Rezervační formulář je k dispozici (GET /api/booking-config); jinak poptávka přes e-chalupy. */
  bookingEnabled: boolean;
  formOpen: boolean;
  onOpenForm: () => void;
  /** Hláška po kliknutí na „Pokračovat k rezervaci“ bez úplného termínu. */
  continueHint: string | null;
  /** Kontaktní část formuláře (pod souhrnem, jen když je formulář otevřený). */
  form?: ReactNode;
  /** Potvrzení po úspěšné rezervaci – nahradí obsah panelu. */
  success?: ReactNode;
}

/** Zelený panel: data pobytu (synchronizovaná s kalendářem), počet hostů a cena ze serveru. */
export function BookingPanel(props: Props) {
  const { today, stay, guests, nights, quote, message, onArrival, onDeparture, onGuests, onRetry, bookingEnabled, formOpen, onOpenForm, continueHint, form, success } = props;
  const { t, plural, formatDate } = useI18n();
  const complete = nights > 0;
  const status = message ?? (quote.kind === 'error' ? quote.message : complete ? null : (continueHint ?? (stay.arrival ? t('booking.panel.selectDeparture') : t('booking.panel.selectStay'))));

  if (success) {
    return (
      <aside className="booking" aria-labelledby="booking-title">
        <p className="eyebrow" id="booking-title">{t('booking.panel.eyebrow')}</p>
        {success}
      </aside>
    );
  }

  return (
    <aside className={`booking${formOpen ? ' is-form-open' : ''}`} aria-labelledby="booking-title" aria-busy={quote.kind === 'loading'}>
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
      {/* Vlastní pole DD.MM.RRRR (ne vizuální formát nativního date inputu, který může být americký). */}
      <div className="date-fields">
        <DateField label={t('booking.panel.arrival')} value={stay.arrival} min={today ?? undefined} onCommit={onArrival} />
        <DateField label={t('booking.panel.departure')} value={stay.departure} min={stay.arrival ?? today ?? undefined} onCommit={onDeparture} />
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
      {bookingEnabled ? (
        formOpen ? (
          form
        ) : (
          <>
            <button type="button" className="button" onClick={onOpenForm}>{t('booking.panel.continue')} <ArrowUpRight size={18} /></button>
            <p className="small">{t('booking.panel.bookingNote')}</p>
          </>
        )
      ) : (
        <>
          <a className="button" href={INQUIRY_URL} target="_blank" rel="noreferrer">{t('booking.panel.inquiry')} <ArrowUpRight size={18} /></a>
          <p className="small">{t('booking.panel.disclaimer')}</p>
        </>
      )}
    </aside>
  );
}
