import { useMemo } from 'react';
import type { PaymentInstructions } from '../../lib/booking/payment.ts';
import { useI18n } from '../i18n.ts';
import { CopyButton } from './CopyButton.tsx';
import { qrRendering } from './paymentQr.ts';

/**
 * Platba v potvrzení rezervace: nadpis se splatností (jen datum v Europe/Prague), QR Platba jako skutečný obrázek (dlouhým podržením
 * jde na mobilu uložit) a sbalené ruční platební údaje s kopírováním. Nepodaří-li se QR vytvořit,
 * ruční údaje jsou rovnou rozbalené.
 */
export function PaymentDetails({ payment }: { payment: PaymentInstructions }) {
  const { t, formatPrice, formatDeadline, formatDeadlineDate } = useI18n();
  const qr = useMemo(() => qrRendering(payment.spayd), [payment.spayd]);
  const qrLabel = t('reservation.payment.qrLabel');
  const rows: { label: string; display: string; copy?: string; className?: string }[] = [
    { label: t('reservation.payment.amount'), display: formatPrice(payment.amountCzk), copy: String(payment.amountCzk) },
    { label: t('reservation.payment.account'), display: payment.accountNumber, copy: payment.accountNumber },
    { label: t('reservation.payment.iban'), display: payment.iban, copy: payment.iban, className: 'booking-payment-iban' },
    { label: t('reservation.payment.variableSymbol'), display: payment.variableSymbol, copy: payment.variableSymbol },
    { label: t('reservation.payment.due'), display: formatDeadline(payment.dueAt) },
  ];
  return (
    <section className="booking-payment" aria-labelledby="booking-payment-heading">
      <div className="booking-payment-header">
        <p className="booking-payment-heading" id="booking-payment-heading">{t('reservation.payment.heading')}</p>
        <p className="booking-payment-due">{t('reservation.payment.dueBy', { date: formatDeadlineDate(payment.dueAt) })}</p>
      </div>
      {qr.kind === 'img' && (
        <>
          <img className="booking-payment-qr" src={qr.src} alt={qrLabel} width={184} height={184} />
          <p className="booking-payment-hint">{t('reservation.payment.qrSaveHint')}</p>
        </>
      )}
      {qr.kind === 'svg' && (
        <svg className="booking-payment-qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={qrLabel} shapeRendering="crispEdges">
          <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
          <path d={qr.d} fill="#0b1f19" />
        </svg>
      )}
      {qr.kind === 'none' && <p className="booking-success-note" role="note">{t('reservation.payment.qrUnavailable')}</p>}
      <details className="booking-payment-more" open={qr.kind === 'none'}>
        <summary>{t('reservation.payment.details')}</summary>
        <dl className="estimate">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                <span className={row.className}>{row.display}</span>
                {row.copy ? <CopyButton value={row.copy} label={row.label} /> : <span className="copy-spacer" aria-hidden />}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
