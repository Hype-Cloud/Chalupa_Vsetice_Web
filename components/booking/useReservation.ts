import { useEffect, useRef, useState } from 'react';
import { BOOKING_DISABLED, fetchBookingConfig, type BookingConfig } from './bookingConfig.ts';
import { createReservationController, IDLE_SUBMISSION, postReservation, type SubmissionState } from './reservation.ts';

/** Časový limit jednoho odeslání; vypršení = síťová chyba (opakovatelná se stejným klíčem). */
const SUBMIT_TIMEOUT_MS = 20_000;

/** Stav odeslání rezervace; logika a životní cyklus Idempotency-Key: reservation.ts. */
export function useReservation(callbacks: { onPriceChanged: () => void; getToken: () => Promise<string> }) {
  const [state, setState] = useState<SubmissionState>(IDLE_SUBMISSION);
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const [controller] = useState(() =>
    createReservationController({
      post: (payload, token, key) => postReservation(payload, token, key, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) })),
      getToken: () => latest.current.getToken(),
      newKey: () => crypto.randomUUID(),
      onChange: setState,
      onPriceChanged: () => latest.current.onPriceChanged(),
    }),
  );
  return { state, submit: controller.submit, dismiss: controller.dismiss };
}

/** Runtime nastavení formuláře; do načtení (a při chybě) je rezervace vypnutá. */
export function useBookingConfig(): BookingConfig {
  const [config, setConfig] = useState<BookingConfig>(BOOKING_DISABLED);
  useEffect(() => {
    const controller = new AbortController();
    fetchBookingConfig((input, init) => fetch(input, init), controller.signal).then((value) => !controller.signal.aborted && setConfig(value));
    return () => controller.abort();
  }, []);
  return config;
}
