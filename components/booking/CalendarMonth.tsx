import { addDays, daysInMonth, weekdayMondayFirst, type IsoDate } from '../../lib/availability/dates.ts';
import type { Occupancy } from '../../lib/availability/occupancy.ts';
import type { Stay } from '../../lib/availability/stay.ts';
import { useI18n } from '../i18n.ts';
import { DAY_STATUS_KEYS } from './stayErrors.ts';

interface Props {
  monthStart: IsoDate;
  today: IsoDate;
  /** null = obsazenost se načítá nebo není dostupná. */
  occupancy: Occupancy | null;
  stay: Stay;
  /** Den, který je v mřížce dosažitelný tabulátorem (roving tabindex). */
  focusDate: IsoDate;
  onPick: (date: IsoDate) => void;
  onFocusDate: (date: IsoDate) => void;
}

export function CalendarMonth({ monthStart, today, occupancy, stay, focusDate, onPick, onFocusDate }: Props) {
  const offset = weekdayMondayFirst(monthStart);
  const days = Array.from({ length: daysInMonth(monthStart) }, (_, i) => addDays(monthStart, i));
  const { t, formatMonth, formatFullDate, weekdays } = useI18n();
  const title = formatMonth(monthStart);
  const titleId = `bk-month-${monthStart}`;

  return (
    <div className="bk-month" role="group" aria-labelledby={titleId}>
      <h4 id={titleId} className="bk-month-title">{title}</h4>
      <div className="bk-weekdays" aria-hidden="true">
        {weekdays().map((name, i) => <span key={i}>{name}</span>)}
      </div>
      <div className="bk-days">
        {Array.from({ length: offset }, (_, i) => <span key={`pad-${i}`} className="bk-pad" aria-hidden="true" />)}
        {days.map((date) => {
          const past = date < today;
          const kind = past ? 'past' : occupancy ? occupancy.day(date) : 'unknown';
          const isArrival = date === stay.arrival;
          const isDeparture = date === stay.departure;
          const inRange = !!stay.arrival && !!stay.departure && date > stay.arrival && date < stay.departure;
          const selection = isArrival ? t('calendar.day.selectedArrival') : isDeparture ? t('calendar.day.selectedDeparture') : inRange ? t('calendar.day.inStay') : null;
          const label = [formatFullDate(date), date === today ? t('calendar.day.today') : null, t(DAY_STATUS_KEYS[kind]), selection].filter(Boolean).join(', ');
          const className = ['bk-day', `is-${kind}`, date === today && 'is-today', isArrival && 'is-arrival', isDeparture && 'is-departure', inRange && 'in-range'].filter(Boolean).join(' ');
          return (
            <button
              key={date}
              type="button"
              className={className}
              data-date={date}
              tabIndex={date === focusDate ? 0 : -1}
              aria-label={label}
              aria-pressed={isArrival || isDeparture || inRange}
              aria-disabled={kind === 'past' || kind === 'busy' || kind === 'unknown' || undefined}
              onClick={() => onPick(date)}
              onFocus={() => onFocusDate(date)}
            >
              {Number(date.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
