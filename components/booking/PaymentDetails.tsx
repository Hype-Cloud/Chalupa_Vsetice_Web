import { useMemo } from 'react';
import type { PaymentInstructions } from '../../lib/booking/payment.ts';
import { useI18n } from '../i18n.ts';
import { qrPath } from './paymentQr.ts';

/** Platební údaje v potvrzení rezervace: QR Platba a vždy i ruční údaje. */
export function PaymentDetails({ payment }: { payment: PaymentInstructions }) {
  const { t, formatPrice, formatDeadline } = useI18n();
  const qr = useMemo(() => qrPath(payment.spayd), [payment.spayd]);
  return (
    <section className="booking-payment" aria-labelledby="booking-payment-heading">
      <p className="booking-payment-heading" id="booking-payment-heading">{t('reservation.payment.heading')}</p>
      {qr ? (
        <svg className="booking-payment-qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={t('reservation.payment.qrLabel')} shapeRendering="crispEdges">
          <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
          <path d={qr.d} fill="#0b1f19" />
        </svg>
      ) : (
        <p className="booking-success-note" role="note">{t('reservation.payment.qrUnavailable')}</p>
      )}
      <dl className="estimate">
        <div><dt>{t('reservation.payment.amount')}</dt><dd>{formatPrice(payment.amountCzk)}</dd></div>
        <div><dt>{t('reservation.payment.account')}</dt><dd>{payment.accountNumber}</dd></div>
        <div><dt>{t('reservation.payment.iban')}</dt><dd className="booking-payment-iban">{payment.iban}</dd></div>
        <div><dt>{t('reservation.payment.variableSymbol')}</dt><dd>{payment.variableSymbol}</dd></div>
        <div><dt>{t('reservation.payment.due')}</dt><dd>{formatDeadline(payment.dueAt)}</dd></div>
      </dl>
    </section>
  );
}
