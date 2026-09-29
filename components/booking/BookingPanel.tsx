import { ArrowUpRight } from 'lucide-react';
import type { IsoDate } from '../../lib/availability/dates.ts';
import { nights, type Stay } from '../../lib/availability/stay.ts';
import { CAPACITY, INQUIRY_URL, PRICE_PER_NIGHT } from './config.ts';
import { formatPrice, formatShortDate, guestsLabel, nightsLabel } from './format.ts';

interface Props {
  today: IsoDate | null;
  stay: Stay;
  guests: number;
  message: string | null;
  onArrival: (date: IsoDate | null) => void;
  onDeparture: (date: IsoDate | null) => void;
  onGuests: (guests: number) => void;
}

/** Zelený panel: data pobytu (synchronizovaná s kalendářem), počet hostů a orientační cena. */
export function BookingPanel({ today, stay, guests, message, onArrival, onDeparture, onGuests }: Props) {
  const count = nights(stay);
  const complete = count > 0;

  return (
    <aside className="booking" aria-labelledby="booking-title">
      <p className="eyebrow" id="booking-title">VAŠE DOVOLENÁ</p>
      <div className="price">{formatPrice(PRICE_PER_NIGHT)} <span>/ noc</span></div>
      <p>Za celou chalupu · až {CAPACITY} hostů</p>
      <div className="date-fields">
        <label>
          Příjezd
          <input type="date" min={today ?? undefined} value={stay.arrival ?? ''} onChange={(e) => onArrival(e.target.value || null)} />
        </label>
        <label>
          Odjezd
          <input type="date" min={stay.arrival ?? today ?? undefined} value={stay.departure ?? ''} onChange={(e) => onDeparture(e.target.value || null)} />
        </label>
      </div>
      <label className="guests-field">
        Počet hostů
        <select value={guests} onChange={(e) => onGuests(Number(e.target.value))}>
          {Array.from({ length: CAPACITY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{guestsLabel(n)}</option>)}
        </select>
      </label>
      <p className="result" aria-live="polite">
        {message ?? (complete ? `${formatShortDate(stay.arrival!)} – ${formatShortDate(stay.departure!)}` : stay.arrival ? 'Vyberte datum odjezdu.' : 'Vyberte termín v kalendáři nebo zadejte data.')}
      </p>
      {complete && (
        <dl className="estimate">
          <div><dt>{nightsLabel(count)} · {guestsLabel(guests)}</dt><dd>{formatPrice(count * PRICE_PER_NIGHT)}</dd></div>
        </dl>
      )}
      <a className="button" href={INQUIRY_URL} target="_blank" rel="noreferrer">Poptat termín <ArrowUpRight size={18} /></a>
      <p className="small">
        Výběr termínu není rezervací. Poptávku odešlete na e-chalupy.cz, kde prosím uveďte zvolený termín a počet hostů. Konečnou cenu a dostupnost potvrdí majitel.
      </p>
    </aside>
  );
}
