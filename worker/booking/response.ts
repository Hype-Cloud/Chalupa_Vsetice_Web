// Veřejná data úspěšně vytvořené rezervace – jediný zdroj pro odpověď POST /api/reservations
// i pro potvrzovací e-mail (worker/booking/confirmation.ts). Nic se nepočítá znovu: souhrn je
// z D1 (insertReservation / replay), platební údaje z paymentInstructions (lib/booking/payment.ts).

import { diffDays, type IsoDate } from '../../lib/availability/dates.ts';
import { paymentInstructions, type PaymentAccount, type PaymentInstructions } from '../../lib/booking/payment.ts';
import type { ReservationStatus, ReservationSummary } from './db.ts';

export interface PublicReservation {
  reservationCode: string;
  arrival: IsoDate;
  departure: IsoDate;
  nights: number;
  guests: number;
  totalCzk: number;
  status: ReservationStatus;
  paymentDueAt: string;
}

/** Úspěšná odpověď API (bez interního ID, kontaktů, poznámky a secrets). */
export interface ReservationResponse {
  reservation: PublicReservation;
  payment: PaymentInstructions;
}

export function reservationResponse(reservation: ReservationSummary, account: PaymentAccount): ReservationResponse {
  return {
    reservation: {
      reservationCode: reservation.code,
      arrival: reservation.arrival,
      departure: reservation.departure,
      nights: diffDays(reservation.arrival, reservation.departure),
      guests: reservation.guests,
      totalCzk: reservation.priceCzk,
      status: reservation.status,
      paymentDueAt: reservation.paymentDueAt,
    },
    payment: paymentInstructions(reservation, account),
  };
}
