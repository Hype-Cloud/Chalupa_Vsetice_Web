import { useEffect, useMemo, useRef, useState } from 'react';
import { isIsoDate, todayInPrague, type IsoDate } from '../../lib/availability/dates.ts';
import { occupancyFromResponse } from '../../lib/availability/occupancy.ts';
import { EMPTY_STAY, nights, pickDay, rangeError, setArrival, setDeparture, type Stay, type StayContext, type StayUpdate } from '../../lib/availability/stay.ts';
import { useI18n } from '../i18n.ts';
import { AvailabilityCalendar } from './AvailabilityCalendar.tsx';
import { BookingPanel } from './BookingPanel.tsx';
import { STAY_ERRORS } from './format.ts';
import { fetchQuote, quoteRequestFor } from './quote.ts';
import { quoteView } from './quoteView.ts';
import { useAvailability } from './useAvailability.ts';
import { useQuote } from './useQuote.ts';

type Source = 'calendar' | 'panel';

/**
 * Kalendář a zelený panel sdílí jeden stav pobytu (termín, hosté) i jednu validaci
 * (lib/availability/stay.ts). Cena je vždy z /api/quote (useQuote) – klient ji nepočítá.
 */
export function BookingSection() {
  // Dnešek se určuje až v prohlížeči, ne při statickém buildu.
  const [today, setToday] = useState<IsoDate | null>(null);
  useEffect(() => setToday(todayInPrague()), []);

  const availability = useAvailability();
  const occupancy = useMemo(() => (availability.phase === 'loaded' ? occupancyFromResponse(availability.data) : null), [availability]);

  const [stay, setStay] = useState<Stay>(EMPTY_STAY);
  const [guests, setGuests] = useState(2);
  const [message, setMessage] = useState<{ text: string; source: Source } | null>(null);
  const i18n = useI18n();
  const quote = useQuote(quoteRequestFor(stay, guests));

  const ctx: StayContext | null = today ? { today, occupancy } : null;
  const apply = (source: Source, update: (ctx: StayContext) => StayUpdate) => {
    if (!ctx) return;
    const result = update(ctx);
    setStay(result.stay);
    setMessage(result.error ? { text: STAY_ERRORS[result.error], source } : null);
  };

  // Nástroj pro prohlížeče s WebMCP (document.modelContext): vybere termín stejnou validací.
  const latest = useRef({ ctx, guests, setStay, setMessage });
  latest.current = { ctx, guests, setStay, setMessage };
  useEffect(() => {
    const mc = (document as unknown as { modelContext?: { registerTool?: (tool: unknown, options: unknown) => unknown } }).modelContext;
    if (!mc?.registerTool) return;
    const controller = new AbortController();
    Promise.resolve(
      mc.registerTool(
        {
          name: 'estimate_stay',
          description: 'Vybere termín pobytu v kalendáři, ověří ho proti zveřejněné obsazenosti a zjistí cenu ze serveru. Nevytváří rezervaci ani poptávku.',
          inputSchema: { type: 'object', properties: { arrival: { type: 'string' }, departure: { type: 'string' } }, required: ['arrival', 'departure'], additionalProperties: false },
          execute: async (input: { arrival: string; departure: string }) => {
            const { ctx: current, guests: currentGuests } = latest.current;
            if (!current || !isIsoDate(input.arrival) || !isIsoDate(input.departure)) throw new Error('Neplatný termín');
            const error = rangeError(input.arrival, input.departure, current);
            if (error && error !== 'range-busy' && error !== 'arrival-busy') throw new Error(STAY_ERRORS[error]);
            if (!error) {
              latest.current.setStay({ arrival: input.arrival, departure: input.departure });
              latest.current.setMessage(null);
              document.getElementById('terminy')?.scrollIntoView();
            }
            const request = quoteRequestFor({ arrival: input.arrival, departure: input.departure }, currentGuests);
            const result = request ? await fetchQuote(request, controller.signal, (url, init) => fetch(url, init)) : null;
            const quote = result?.ok ? result.quote : null;
            return {
              nights: nights({ arrival: input.arrival, departure: input.departure }),
              priceCzk: quote?.totalCzk ?? null,
              pricingMode: quote?.pricingMode ?? null,
              available: !error,
              reservationCreated: false,
            };
          },
        },
        { signal: controller.signal },
      ),
    ).catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div className="booking-grid">
      <div className="calendar-panel">
        <div className="calendar-title"><h3>Kalendář obsazenosti</h3></div>
        {today ? (
          <AvailabilityCalendar
            today={today}
            availability={availability}
            occupancy={occupancy}
            stay={stay}
            message={message?.source === 'calendar' ? message.text : null}
            onPick={(date) => apply('calendar', (c) => pickDay(stay, date, c))}
          />
        ) : (
          <div className="bk-calendar is-placeholder" role="status">Načítáme kalendář…</div>
        )}
      </div>
      <BookingPanel
        today={today}
        stay={stay}
        guests={guests}
        nights={nights(stay)}
        quote={quoteView(quote.state, i18n)}
        message={message?.source === 'panel' ? message.text : null}
        onArrival={(date) => apply('panel', (c) => setArrival(stay, date, c))}
        onDeparture={(date) => apply('panel', (c) => setDeparture(stay, date, c))}
        onGuests={setGuests}
        onRetry={quote.retry}
      />
    </div>
  );
}
