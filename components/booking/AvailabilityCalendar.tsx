import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, addMonths, startOfMonth, type IsoDate } from '../../lib/availability/dates.ts';
import { isIncomplete, type Occupancy } from '../../lib/availability/occupancy.ts';
import type { Stay } from '../../lib/availability/stay.ts';
import { CalendarMonth } from './CalendarMonth.tsx';
import { HORIZON_MONTHS, INQUIRY_URL } from './config.ts';
import { formatDateTime, formatRange } from './format.ts';
import type { AvailabilityState } from './useAvailability.ts';

// Měsíc potřebuje alespoň 230 px, aby dny zůstaly dobře čitelné a klikatelné; mezera 24 px.
const MIN_MONTH_WIDTH = 230;
const MONTH_GAP = 24;
const monthsFor = (width: number) => Math.max(1, Math.min(3, Math.floor((width + MONTH_GAP) / (MIN_MONTH_WIDTH + MONTH_GAP))));
const monthIndex = (from: IsoDate, date: IsoDate) => (Number(date.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(from.slice(5, 7));
const KEY_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

interface Props {
  today: IsoDate;
  availability: AvailabilityState;
  occupancy: Occupancy | null;
  stay: Stay;
  message: string | null;
  onPick: (date: IsoDate) => void;
}

export function AvailabilityCalendar({ today, availability, occupancy, stay, message, onPick }: Props) {
  const firstMonth = startOfMonth(today);
  const lastDay = addDays(addMonths(firstMonth, HORIZON_MONTHS), -1);
  const monthsRef = useRef<HTMLDivElement>(null);
  const [perView, setPerView] = useState(1);
  const [offset, setOffset] = useState(0);
  const [focusDate, setFocusDate] = useState<IsoDate>(stay.arrival ?? today);
  const moveFocus = useRef(false);

  useLayoutEffect(() => {
    const element = monthsRef.current;
    if (!element) return;
    const measure = () => setPerView(monthsFor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Při změně šířky zůstává první zobrazený měsíc stejný (jen se omezí na konec horizontu).
  const maxOffset = HORIZON_MONTHS - perView;
  const first = Math.min(offset, maxOffset);
  const months = Array.from({ length: perView }, (_, i) => addMonths(firstMonth, first + i));
  const visible = (date: IsoDate) => {
    const index = monthIndex(firstMonth, date);
    return index >= first && index < first + perView;
  };
  const reveal = (date: IsoDate) => {
    const index = monthIndex(firstMonth, date);
    if (index < first) setOffset(Math.max(0, index));
    else if (index >= first + perView) setOffset(Math.min(maxOffset, index - perView + 1));
  };

  // Datum příjezdu zadané v panelu se v kalendáři zobrazí.
  useEffect(() => {
    if (stay.arrival && stay.arrival >= firstMonth && stay.arrival <= lastDay && !visible(stay.arrival)) reveal(stay.arrival);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stay.arrival]);

  // Tabulátorem dosažitelný den musí být vidět.
  const tabbable = visible(focusDate) ? focusDate : months[0] < today && visible(today) ? today : months[0];

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    monthsRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  }, [focusDate, first]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[event.key];
    const current = (event.target as HTMLElement).dataset?.date;
    if (!step || !current) return;
    event.preventDefault();
    const next = addDays(current, step);
    if (next < firstMonth || next > lastDay) return;
    reveal(next);
    moveFocus.current = true;
    setFocusDate(next);
  };

  const status = (() => {
    if (availability.phase === 'loading') return <p className="bk-status" role="status">Načítáme aktuální obsazenost…</p>;
    if (availability.phase === 'error' || availability.data.status === 'unavailable') {
      return (
        <p className="bk-status is-warning" role="alert">
          Obsazenost se teď nepodařilo načíst, proto termíny nelze vybrat. Volné termíny ověříte na{' '}
          <a href={INQUIRY_URL} target="_blank" rel="noreferrer">e-chalupy.cz ↗</a>.
        </p>
      );
    }
    const { status: dataStatus, updatedAt } = availability.data;
    if (isIncomplete(availability.data)) {
      return (
        <p className="bk-status is-warning" role="status">
          Část obsazenosti z e-chalupy.cz se nepodařilo načíst, proto teď termíny nelze vybrat. Známé obsazené dny zobrazujeme, volné termíny ověříte na{' '}
          <a href={INQUIRY_URL} target="_blank" rel="noreferrer">e-chalupy.cz ↗</a>.
        </p>
      );
    }
    if (dataStatus === 'stale') {
      return (
        <p className="bk-status is-warning" role="status">
          Obsazenost se nepodařilo obnovit, zobrazujeme stav z {updatedAt ? formatDateTime(updatedAt) : 'poslední synchronizace'}. Termín potvrdí majitel.
        </p>
      );
    }
    return <p className="bk-status">Obsazenost z e-chalupy.cz{updatedAt ? ` · aktualizováno ${formatDateTime(updatedAt)}` : ''}</p>;
  })();

  const hint = !stay.arrival || stay.departure ? 'Klikněte na den příjezdu.' : 'Teď vyberte den odjezdu.';

  return (
    <div className="bk-calendar">
      <div className="calendar-nav">
        <button type="button" onClick={() => setOffset(Math.max(0, first - perView))} disabled={first <= 0} aria-label="Předchozí měsíce">
          <ChevronLeft size={18} strokeWidth={1.6} />
        </button>
        <span aria-live="polite">{formatRange(months[0], months[months.length - 1])}</span>
        <button type="button" onClick={() => setOffset(Math.min(maxOffset, first + perView))} disabled={first >= maxOffset} aria-label="Další měsíce">
          <ChevronRight size={18} strokeWidth={1.6} />
        </button>
      </div>
      <p className="bk-hint" aria-live="polite">{message ?? hint}</p>
      <div ref={monthsRef} className="bk-months" style={{ gridTemplateColumns: `repeat(${perView}, minmax(0, 1fr))` }} onKeyDown={onKeyDown}>
        {months.map((monthStart) => (
          <CalendarMonth key={monthStart} monthStart={monthStart} today={today} occupancy={occupancy} stay={stay} focusDate={tabbable} onPick={onPick} onFocusDate={setFocusDate} />
        ))}
      </div>
      <ul className="bk-legend" aria-label="Legenda">
        <li><i className="is-free" /> Volno</li>
        <li><i className="is-busy" /> Obsazeno</li>
        <li><i className="is-checkin" /> Příjezd / odjezd jiných hostů</li>
        <li><i className="is-selected" /> Váš pobyt</li>
        <li><i className="is-today" /> Dnes</li>
      </ul>
      {status}
    </div>
  );
}
