import { useEffect, useMemo, useRef, useState } from 'react';
import { isIsoDate, todayInPrague, type IsoDate } from '../../lib/availability/dates.ts';
import { occupancyFromResponse } from '../../lib/availability/occupancy.ts';
import { EMPTY_STAY, nights, pickDay, rangeError, setArrival, setDeparture, type Stay, type StayContext, type StayError, type StayUpdate } from '../../lib/availability/stay.ts';
import { useI18n } from '../i18n.ts';
import { AvailabilityCalendar } from './AvailabilityCalendar.tsx';
import { BookingForm, BookingSuccess } from './BookingForm.tsx';
import { BookingPanel } from './BookingPanel.tsx';
import { fetchQuote, quoteKey, quoteRequestFor } from './quote.ts';
import { EMPTY_CONTACT, reservationPayload, submitBlock, type ContactDraft } from './reservation.ts';
import { quoteView } from './quoteView.ts';
import { STAY_ERROR_KEYS } from './stayErrors.ts';
import { useAvailability } from './useAvailability.ts';
import { useQuote } from './useQuote.ts';
import { useBookingConfig, useReservation } from './useReservation.ts';

type Source = 'calendar' | 'panel';

/**
 * Kalendář a zelený panel sdílí jeden stav pobytu (termín, hosté) i jednu validaci
 * (lib/availability/stay.ts). Cena je vždy z /api/quote (useQuote) – klient ji nepočítá.
 * Rezervační formulář (jen když ho GET /api/booking-config povolí) je pokračováním stejného
 * panelu; kontakty se drží odděleně od termínu, takže změna termínu, hostů ani jazyka je nesmaže.
 */
export function BookingSection() {
  // Dnešek se určuje až v prohlížeči, ne při statickém buildu.
  const [today, setToday] = useState<IsoDate | null>(null);
  useEffect(() => setToday(todayInPrague()), []);

  const availability = useAvailability();
  const occupancy = useMemo(() => (availability.phase === 'loaded' ? occupancyFromResponse(availability.data) : null), [availability]);

  const [stay, setStay] = useState<Stay>(EMPTY_STAY);
  const [guests, setGuests] = useState(2);
  // Kód chyby výběru (ne text) – hláška se přeloží až při zobrazení, takže po přepnutí jazyka sedí.
  const [message, setMessage] = useState<{ error: StayError; source: Source } | null>(null);
  const i18n = useI18n();
  const request = quoteRequestFor(stay, guests);
  const quote = useQuote(request);

  // Rezervační formulář
  const config = useBookingConfig();
  const [formOpen, setFormOpen] = useState(false);
  const [continueHint, setContinueHint] = useState(false);
  const [contact, setContact] = useState<ContactDraft>(EMPTY_CONTACT);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  const reservation = useReservation({
    // Server hlásí jinou cenu → znovu načíst autoritativní nabídku (summary ukáže nový rozpis).
    onPriceChanged: quote.retry,
    onTurnstileReset: () => setTurnstileReset((n) => n + 1),
  });
  const stayKey = quoteKey(request);
  // Změna termínu nebo hostů zahodí hlášky předchozího odeslání (formulář i kontakty zůstávají).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reservation.dismiss(), [stayKey]);
  useEffect(() => {
    if (request) setContinueHint(false);
  }, [stayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const quoteReady = quote.state.status === 'ready' && quoteKey(quote.state.request) === stayKey ? quote.state.quote : null;
  const block = submitBlock({
    stayComplete: request !== null,
    quoteStatus: quoteReady ? 'ready' : quote.state.status === 'loading' ? 'loading' : quote.state.status === 'idle' ? 'idle' : 'error',
    contact,
    turnstileToken,
    submission: reservation.state,
  });
  const submit = () => {
    if (block || !request || !quoteReady || !turnstileToken) return;
    void reservation.submit(
      reservationPayload({ arrival: request.arrivalDate, departure: request.departureDate, guests, contact, expectedPriceCzk: quoteReady.totalCzk }),
      turnstileToken,
    );
  };
  const submission = reservation.state;
  const priceChanged =
    submission.status === 'price-changed'
      ? i18n.t('reservation.priceChanged', { from: i18n.formatPrice(submission.fromCzk), to: i18n.formatPrice(quoteReady?.totalCzk ?? submission.toCzk) })
      : null;

  const ctx: StayContext | null = today ? { today, occupancy } : null;
  const apply = (source: Source, update: (ctx: StayContext) => StayUpdate) => {
    if (!ctx) return;
    const result = update(ctx);
    setStay(result.stay);
    setMessage(result.error ? { error: result.error, source } : null);
  };

  // Nástroj pro prohlížeče s WebMCP (document.modelContext): vybere termín stejnou validací.
  const latest = useRef({ ctx, guests, i18n, setStay, setMessage });
  latest.current = { ctx, guests, i18n, setStay, setMessage };
  useEffect(() => {
    const mc = (document as unknown as { modelContext?: { registerTool?: (tool: unknown, options: unknown) => unknown } }).modelContext;
    if (!mc?.registerTool) return;
    const controller = new AbortController();
    Promise.resolve(
      mc.registerTool(
        {
          name: 'estimate_stay',
          description: latest.current.i18n.t('agent.estimateStay.description'),
          inputSchema: { type: 'object', properties: { arrival: { type: 'string' }, departure: { type: 'string' } }, required: ['arrival', 'departure'], additionalProperties: false },
          execute: async (input: { arrival: string; departure: string }) => {
            const { ctx: current, guests: currentGuests, i18n: currentI18n } = latest.current;
            if (!current || !isIsoDate(input.arrival) || !isIsoDate(input.departure)) throw new Error(currentI18n.t('agent.estimateStay.invalid'));
            const error = rangeError(input.arrival, input.departure, current);
            if (error && error !== 'range-busy' && error !== 'arrival-busy') throw new Error(currentI18n.t(STAY_ERROR_KEYS[error]));
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
        <div className="calendar-title"><h3>{i18n.t('calendar.title')}</h3></div>
        {today ? (
          <AvailabilityCalendar
            today={today}
            availability={availability}
            occupancy={occupancy}
            stay={stay}
            message={message?.source === 'calendar' ? i18n.t(STAY_ERROR_KEYS[message.error]) : null}
            onPick={(date) => apply('calendar', (c) => pickDay(stay, date, c))}
          />
        ) : (
          <div className="bk-calendar is-placeholder" role="status">{i18n.t('calendar.loading')}</div>
        )}
      </div>
      <BookingPanel
        today={today}
        stay={stay}
        guests={guests}
        nights={nights(stay)}
        quote={quoteView(quote.state, i18n)}
        message={message?.source === 'panel' ? i18n.t(STAY_ERROR_KEYS[message.error]) : null}
        onArrival={(date) => apply('panel', (c) => setArrival(stay, date, c))}
        onDeparture={(date) => apply('panel', (c) => setDeparture(stay, date, c))}
        onGuests={setGuests}
        onRetry={quote.retry}
        bookingEnabled={config.bookingEnabled}
        formOpen={formOpen}
        onOpenForm={() => {
          if (request) setFormOpen(true);
          else setContinueHint(true);
        }}
        continueHint={continueHint ? i18n.t('reservation.blocked.stay') : null}
        form={
          config.turnstileSiteKey && (
            <BookingForm
              contact={contact}
              onContact={(next) => {
                setContact(next);
                // Opravený údaj: zahodit hlášky u polí z předchozí odpovědi 422.
                if (submission.status === 'invalid') reservation.dismiss();
              }}
              submission={submission}
              block={block}
              priceChanged={priceChanged}
              siteKey={config.turnstileSiteKey}
              turnstileResetSignal={turnstileReset}
              onToken={setTurnstileToken}
              onSubmit={submit}
            />
          )
        }
        success={submission.status === 'success' ? <BookingSuccess reservation={submission.reservation} /> : undefined}
      />
    </div>
  );
}
